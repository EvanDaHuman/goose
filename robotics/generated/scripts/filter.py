#!/usr/bin/env python3
# Copyright (c) 2016, Ahmet Ozturk (aoztrk41@gmail.com)
# Copyright (c) 2024 Goose Robotics
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.
#
# Original source: https://github.com/hasauino/rrt_exploration (MIT License)
# Migrated from ROS1 to ROS2 Jazzy for goose_rrt_exploration.
"""Frontier filtering node.

Consumes /detected_points (geometry_msgs/PointStamped) and /map
(nav_msgs/OccupancyGrid).  Clusters the detected RRT frontier points with
mean-shift, removes candidates that are occupied (grid value above
threshold on the costmap) or have low information gain, and publishes the
surviving centroids on /filtered_points as goose_rrt_exploration/PointArray.

This is a faithful port of the original MIT rrt_exploration filter, adapted to
ROS2 Jazzy: timer callbacks replace the blocking while-loop, sklearn is
replaced by a numpy-only mean-shift, and tf2_ros is used for transforms.
"""

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from rclpy.duration import Duration
from nav_msgs.msg import OccupancyGrid
from geometry_msgs.msg import PointStamped, Point
from visualization_msgs.msg import Marker
from tf2_ros import Buffer, TransformListener
import tf2_geometry_msgs  # noqa: F401  (registers PointStamped with tf2)

import core
from goose_rrt_exploration.msg import PointArray


def _meanshift(points, bandwidth=0.3, max_iter=20):
    """Mean-shift clustering without sklearn (flat kernel, single bandwidth).

    Re-implements the behaviour of ``sklearn.cluster.MeanShift`` for 2-D
    points using only numpy: every point starts as a seed centroid; each
    iteration moves each centroid to the mean of the points within
    *bandwidth*; converged centroids closer than half the bandwidth are
    merged into one cluster centre.
    """
    pts = np.asarray(points, dtype=float)
    if pts.size == 0:
        return np.empty((0, 2))
    if pts.ndim == 1:
        pts = pts.reshape(1, -1)
    if len(pts) == 1:
        return pts.copy()

    centroids = pts.copy()
    for _ in range(max_iter):
        new_centroids = np.empty_like(centroids)
        for idx, c in enumerate(centroids):
            d = np.linalg.norm(pts - c, axis=1)
            in_window = pts[d <= bandwidth]
            if len(in_window) > 0:
                new_centroids[idx] = in_window.mean(axis=0)
            else:
                new_centroids[idx] = c
        shift = np.linalg.norm(new_centroids - centroids, axis=1)
        centroids = new_centroids
        if shift.max() < 1e-3:
            break

    # Merge centroids that converged to within half the bandwidth.
    merged = []
    for c in centroids:
        keep = True
        for u in merged:
            if np.linalg.norm(c - u) < bandwidth * 0.5:
                keep = False
                break
        if keep:
            merged.append(c)
    return np.array(merged) if merged else np.empty((0, 2))


class FilterNode(Node):
    def __init__(self):
        super().__init__('filter')

        # ---- parameters ---------------------------------------------------
        self.declare_parameter('map_topic', '/map')
        self.declare_parameter('costmap_clearing_threshold', 70)
        self.declare_parameter('info_radius', 1.0)
        self.declare_parameter('goals_topic', '/detected_points')
        self.declare_parameter('global_costmap_topic', '/global_costmap/costmap')
        self.declare_parameter('robot_frame', 'base_link')
        self.declare_parameter('rate', 10.0)

        self.map_topic = self.get_parameter('map_topic').value
        self.threshold = int(self.get_parameter('costmap_clearing_threshold').value)
        self.info_radius = float(self.get_parameter('info_radius').value)
        self.goals_topic = self.get_parameter('goals_topic').value
        self.global_costmap_topic = self.get_parameter('global_costmap_topic').value
        self.robot_frame = self.get_parameter('robot_frame').value
        rate_hz = float(self.get_parameter('rate').value)
        if rate_hz <= 0.0:
            rate_hz = 10.0

        # ---- state --------------------------------------------------------
        self.map_data = None
        self.costmap_data = None
        self.frontiers = np.empty((0, 2))
        self._shutdown = False

        # ---- TF -----------------------------------------------------------
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)

        # ---- subscribers --------------------------------------------------
        map_qos = QoSProfile(
            depth=1,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
        )
        self.map_sub = self.create_subscription(
            OccupancyGrid, self.map_topic, self._map_cb, map_qos)
        self.costmap_sub = self.create_subscription(
            OccupancyGrid, self.global_costmap_topic, self._costmap_cb, 10)
        self.points_sub = self.create_subscription(
            PointStamped, self.goals_topic, self._points_cb, 10)

        # ---- publishers ---------------------------------------------------
        self.filter_pub = self.create_publisher(
            PointArray, '/filtered_points', 10)
        self.frontiers_pub = self.create_publisher(Marker, 'frontiers', 10)
        self.centroids_pub = self.create_publisher(Marker, 'centroids', 10)

        # ---- timer (bounded main loop) ------------------------------------
        self.timer = self.create_timer(1.0 / rate_hz, self._timer_cb)
        self.get_logger().info('filter node ready')

    # ------------------------------------------------------------------
    @staticmethod
    def _norm_frame(frame_id):
        """Strip a leading slash so the frame id is usable with tf2."""
        if frame_id and frame_id.startswith('/'):
            return frame_id[1:]
        return frame_id

    # -- subscriber callbacks ------------------------------------------
    def _map_cb(self, msg):
        self.map_data = msg

    def _costmap_cb(self, msg):
        self.costmap_data = msg

    def _points_cb(self, msg):
        if self._shutdown or self.map_data is None:
            return
        target = self._norm_frame(self.map_data.header.frame_id)
        try:
            transformed = self.tf_buffer.transform(
                msg, target, timeout=Duration(seconds=0.1))
        except Exception as exc:  # tf unavailable / extrapolation
            self.get_logger().warn(
                'Could not transform detected point to map frame: %s' % exc,
                throttle_duration_sec=2.0,
            )
            return
        x = np.array([[transformed.point.x, transformed.point.y]])
        if self.frontiers.size > 0:
            self.frontiers = np.vstack((self.frontiers, x))
        else:
            self.frontiers = x

    # -- main loop (timer) ---------------------------------------------
    def _timer_cb(self):
        if self._shutdown or self.map_data is None:
            return
        if len(self.frontiers) < 1:
            return

        front = self.frontiers.copy()
        if len(front) > 1:
            centroids = _meanshift(front, bandwidth=0.3)
        elif len(front) == 1:
            centroids = front.copy()
        else:
            return

        # Update frontier list to cluster centres (original behaviour).
        self.frontiers = centroids.copy()

        # -- clearing old / invalid frontiers ------------------------------
        z = 0
        while z < len(centroids):
            cx = float(centroids[z][0])
            cy = float(centroids[z][1])
            cond = False

            costmap = self.costmap_data if self.costmap_data is not None \
                else self.map_data
            if costmap is not None:
                gv = core.gridValue(costmap, [cx, cy])
                cond = (gv > self.threshold) or cond

            ig = core.informationGain(
                self.map_data, [cx, cy], self.info_radius * 0.5)
            if cond or ig < 0.2:
                centroids = np.delete(centroids, z, axis=0)
                z -= 1
            z += 1

        # -- publish filtered points ---------------------------------------
        arraypoints = PointArray()
        for i in range(len(centroids)):
            p = Point()
            p.x = float(centroids[i][0])
            p.y = float(centroids[i][1])
            p.z = 0.0
            arraypoints.points.append(p)
        self.filter_pub.publish(arraypoints)

        # -- publish visualization markers ----------------------------------
        self._publish_markers(centroids)

    def _publish_markers(self, centroids):
        stamp = self.get_clock().now().to_msg()
        frame = self.map_data.header.frame_id if self.map_data else 'map'

        # frontier (pre-filter) marker – yellow points
        m_front = Marker()
        m_front.header.frame_id = frame
        m_front.header.stamp = stamp
        m_front.ns = 'markers2'
        m_front.id = 0
        m_front.type = Marker.POINTS
        m_front.action = Marker.ADD
        m_front.pose.orientation.w = 1.0
        m_front.scale.x = 0.2
        m_front.scale.y = 0.2
        m_front.color.r = 1.0
        m_front.color.g = 1.0
        m_front.color.b = 0.0
        m_front.color.a = 1.0
        for q in range(len(self.frontiers)):
            p = Point()
            p.x = float(self.frontiers[q][0])
            p.y = float(self.frontiers[q][1])
            p.z = 0.0
            m_front.points.append(p)
        self.frontiers_pub.publish(m_front)

        # centroid (post-filter) marker – green points
        m_cent = Marker()
        m_cent.header.frame_id = frame
        m_cent.header.stamp = stamp
        m_cent.ns = 'markers3'
        m_cent.id = 4
        m_cent.type = Marker.POINTS
        m_cent.action = Marker.ADD
        m_cent.pose.orientation.w = 1.0
        m_cent.scale.x = 0.2
        m_cent.scale.y = 0.2
        m_cent.color.r = 0.0
        m_cent.color.g = 1.0
        m_cent.color.b = 0.0
        m_cent.color.a = 1.0
        for q in range(len(centroids)):
            p = Point()
            p.x = float(centroids[q][0])
            p.y = float(centroids[q][1])
            p.z = 0.0
            m_cent.points.append(p)
        self.centroids_pub.publish(m_cent)

    # -- shutdown ------------------------------------------------------
    def destroy_node(self):
        self._shutdown = True
        if self.timer is not None:
            self.timer.cancel()
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = FilterNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
