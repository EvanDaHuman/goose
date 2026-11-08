#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# goose_rrt_exploration - ROS2 migration of the MIT rrt_exploration assigner.
#
# Copyright (c) 2016 the original rrt_exploration authors (MIT License)
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

"""ROS2 assigner node for goose_rrt_exploration.

Consumes /map (nav_msgs/OccupancyGrid) and /filtered_points
(goose_rrt_exploration/PointArray), looks up the map->base_link transform,
and dispatches a single active Nav2 NavigateToPose goal at a time using an
information-gain minus travel-cost objective with hysteresis.

The algorithm logic (informationGain, discount, gridValue) is provided by
core.py which is installed beside this script and importable without ROS.
"""

import json
import math
import os
import random
import sys

# Ensure core.py (installed beside this script) is importable regardless of CWD.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import core  # noqa: E402  (after sys.path manipulation)

import rclpy  # noqa: E402
from rclpy.node import Node  # noqa: E402
from rclpy.qos import (  # noqa: E402
    QoSProfile,
    DurabilityPolicy,
    ReliabilityPolicy,
    HistoryPolicy,
)
from rclpy.action import ActionClient  # noqa: E402
from rclpy.duration import Duration  # noqa: E402
from rclpy.time import Time  # noqa: E402
from action_msgs.msg import GoalStatus  # noqa: E402
from nav2_msgs.action import NavigateToPose  # noqa: E402
from nav_msgs.msg import OccupancyGrid  # noqa: E402
from std_msgs.msg import String  # noqa: E402
from tf2_ros import Buffer, TransformListener, TransformException  # noqa: E402

from goose_rrt_exploration.msg import PointArray  # noqa: E402


class AssignerNode(Node):
    """Assigns frontier exploration goals to a single Nav2-driven robot."""

    # Occupancy-grid value at or above which a cell is considered occupied.
    _OCCUPIED_THRESHOLD = 50

    def __init__(self):
        super().__init__('assigner')

        # ------------------------------------------------------------------
        # Parameters
        # ------------------------------------------------------------------
        self.declare_parameter('map_topic', '/map')
        self.declare_parameter('frontiers_topic', '/filtered_points')
        self.declare_parameter('info_radius', 1.0)
        self.declare_parameter('info_multiplier', 3.0)
        self.declare_parameter('hysteresis_radius', 3.0)
        self.declare_parameter('hysteresis_gain', 2.0)
        self.declare_parameter('global_frame', 'map')
        self.declare_parameter('robot_frame', 'base_link')
        self.declare_parameter('max_goals', 0)
        self.declare_parameter('random_seed', 0)
        self.declare_parameter('delay_after_assignment', 0.5)
        self.declare_parameter('rate', 2.0)
        self.declare_parameter('action_server', 'navigate_to_pose')

        self.map_topic = self.get_parameter('map_topic').value
        self.frontiers_topic = self.get_parameter('frontiers_topic').value
        self.info_radius = float(self.get_parameter('info_radius').value)
        self.info_multiplier = float(self.get_parameter('info_multiplier').value)
        self.hysteresis_radius = float(
            self.get_parameter('hysteresis_radius').value)
        self.hysteresis_gain = float(self.get_parameter('hysteresis_gain').value)
        self.global_frame = self.get_parameter('global_frame').value
        self.robot_frame = self.get_parameter('robot_frame').value
        self.max_goals = int(self.get_parameter('max_goals').value)
        self.random_seed = int(self.get_parameter('random_seed').value)
        self.delay_after_assignment = float(
            self.get_parameter('delay_after_assignment').value)
        rate_hz = float(self.get_parameter('rate').value)
        self.action_server = self.get_parameter('action_server').value

        if self.random_seed != 0:
            random.seed(self.random_seed)

        # ------------------------------------------------------------------
        # Runtime state
        # ------------------------------------------------------------------
        self.map_data = None          # latest OccupancyGrid
        self.frontiers = []            # list of [x, y] plain-lists
        self.assigned_point = None     # [x, y] last assigned goal centre
        self.position = None           # [x, y] latest robot pose
        self.goal_handle = None        # active ClientGoalHandle or None
        self.goal_pending = False      # goal sent, awaiting accept/reject
        self.completed_goals = 0
        self.failed_goals = 0
        self.selected_goal = None      # [x, y] or None
        self.shutting_down = False
        self.last_assign_time = 0.0

        # ------------------------------------------------------------------
        # TF
        # ------------------------------------------------------------------
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)

        # ------------------------------------------------------------------
        # Action client (Nav2 NavigateToPose)
        # ------------------------------------------------------------------
        self.action_client = ActionClient(
            self, NavigateToPose, self.action_server)

        # ------------------------------------------------------------------
        # Subscribers
        # ------------------------------------------------------------------
        # /map is latched (transient-local) in most SLAM setups.
        map_qos = QoSProfile(
            depth=1,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
            reliability=ReliabilityPolicy.RELIABLE,
            history=HistoryPolicy.KEEP_LAST,
        )
        self.create_subscription(
            OccupancyGrid, self.map_topic, self._map_callback, map_qos)
        self.create_subscription(
            PointArray, self.frontiers_topic, self._frontiers_callback, 10)

        # ------------------------------------------------------------------
        # Publishers
        # ------------------------------------------------------------------
        self.status_pub = self.create_publisher(
            String, '/goose/exploration_status', 10)

        # ------------------------------------------------------------------
        # Main timer (bounded, non-blocking callback)
        # ------------------------------------------------------------------
        timer_period = 1.0 / max(rate_hz, 0.1)
        self.timer = self.create_timer(timer_period, self._timer_callback)

        self.get_logger().info('Assigner node started')

    # ------------------------------------------------------------------
    # Subscriber callbacks
    # ------------------------------------------------------------------
    def _map_callback(self, data):
        self.map_data = data

    def _frontiers_callback(self, data):
        self.frontiers = []
        for pt in data.points:
            self.frontiers.append([float(pt.x), float(pt.y)])

    # ------------------------------------------------------------------
    # TF helper
    # ------------------------------------------------------------------
    def _get_position(self):
        """Return [x, y] robot position in global_frame, or None on failure."""
        try:
            tf = self.tf_buffer.lookup_transform(
                self.global_frame,
                self.robot_frame,
                Time(),
                timeout=Duration(seconds=0.1))
            return [float(tf.transform.translation.x),
                    float(tf.transform.translation.y)]
        except TransformException as ex:
            self.get_logger().warn(
                'Could not transform %s -> %s: %s'
                % (self.robot_frame, self.global_frame, str(ex)),
                throttle_duration_sec=5.0)
            return None

    # ------------------------------------------------------------------
    # Action helpers
    # ------------------------------------------------------------------
    def _send_goal(self, x, y):
        """Send a NavigateToPose goal asynchronously (non-blocking)."""
        if self.goal_handle is not None or self.goal_pending:
            return
        if not self.action_client.server_is_ready():
            self.get_logger().warn(
                'Action server "%s" not ready'
                % self.action_server,
                throttle_duration_sec=5.0)
            return

        # Use the map header's frame id, normalised (no leading slash).
        frame_id = self.global_frame
        if self.map_data is not None and self.map_data.header.frame_id:
            frame_id = self.map_data.header.frame_id
        if frame_id.startswith('/'):
            frame_id = frame_id[1:]

        goal = NavigateToPose.Goal()
        goal.pose.header.stamp = self.get_clock().now().to_msg()
        goal.pose.header.frame_id = frame_id
        goal.pose.pose.position.x = float(x)
        goal.pose.pose.position.y = float(y)
        goal.pose.pose.orientation.w = 1.0

        self.goal_pending = True
        self.selected_goal = [float(x), float(y)]
        future = self.action_client.send_goal_async(goal)
        future.add_done_callback(self._goal_response_callback)
        self.get_logger().info(
            'Sending goal [%.3f, %.3f] frame=%s' % (x, y, frame_id))

    def _goal_response_callback(self, future):
        """Handle goal accept/reject (done callback from send_goal_async)."""
        self.goal_pending = False
        try:
            goal_handle = future.result()
        except Exception as exc:  # pragma: no cover - network/server error
            self.get_logger().error('Goal send failed: %s' % str(exc))
            self.failed_goals += 1
            self.selected_goal = None
            return

        if goal_handle is None or not goal_handle.accepted:
            self.get_logger().warn('Goal rejected by action server')
            self.failed_goals += 1
            self.selected_goal = None
            return

        self.goal_handle = goal_handle
        result_future = goal_handle.get_result_async()
        result_future.add_done_callback(self._result_callback)

    def _result_callback(self, future):
        """Handle NavigateToPose result (done callback from get_result_async)."""
        try:
            wrapped = future.result()
        except Exception as exc:  # pragma: no cover
            self.get_logger().error('Get result failed: %s' % str(exc))
            self.failed_goals += 1
            self.goal_handle = None
            self.selected_goal = None
            return

        status = (wrapped.status if wrapped is not None
                  else GoalStatus.STATUS_ABORTED)
        if status == GoalStatus.STATUS_SUCCEEDED:
            self.completed_goals += 1
            self.get_logger().info('Goal succeeded (completed=%d)'
                                   % self.completed_goals)
        else:
            self.failed_goals += 1
            self.get_logger().info('Goal failed status=%d (failed=%d)'
                                   % (status, self.failed_goals))

        self.goal_handle = None
        self.selected_goal = None

    # ------------------------------------------------------------------
    # Status publisher
    # ------------------------------------------------------------------
    def _publish_status(self):
        msg = String()
        status = {
            'completed_goals': self.completed_goals,
            'failed_goals': self.failed_goals,
            'selected_goal': self.selected_goal,
            'state': 'active' if self.goal_handle is not None else 'idle',
            'position': self.position,
        }
        msg.data = json.dumps(status)
        self.status_pub.publish(msg)

    # ------------------------------------------------------------------
    # Main timer callback (bounded — no blocking waits)
    # ------------------------------------------------------------------
    def _timer_callback(self):
        if self.shutting_down:
            return

        # Need both map and frontiers.
        if self.map_data is None or len(self.frontiers) < 1:
            self._publish_status()
            return

        # Only one active goal at a time; do not dispatch while pending.
        if self.goal_handle is not None or self.goal_pending:
            self._publish_status()
            return

        # Respect max_goals (0 == unlimited).
        if self.max_goals > 0 and self.completed_goals >= self.max_goals:
            self._publish_status()
            return

        # Respect delay_after_assignment.
        now_sec = self.get_clock().now().nanoseconds / 1e9
        if now_sec - self.last_assign_time < self.delay_after_assignment:
            self._publish_status()
            return

        # Robot pose via TF.
        position = self._get_position()
        if position is None:
            self._publish_status()
            return
        self.position = position

        # Initialise assigned_point to current pose (legacy sends robot to
        # its own position on startup so discount/hysteresis start correctly).
        if self.assigned_point is None:
            self.assigned_point = list(position)

        # ------------------------------------------------------------------
        # Algorithm: information gain minus travel cost with hysteresis
        # (mirrors the legacy assigner main loop)
        # ------------------------------------------------------------------
        centroids = list(self.frontiers)  # snapshot

        # Information gain for each frontier.
        info_gain = []
        for c in centroids:
            info_gain.append(
                core.informationGain(self.map_data, [c[0], c[1]],
                                     self.info_radius))

        # Discount: reduce gain of unknown cells already covered by the
        # currently assigned goal region.
        ap = [float(self.assigned_point[0]), float(self.assigned_point[1])]
        info_gain = core.discount(
            self.map_data, ap, centroids, info_gain, self.info_radius)

        # Select the best frontier by revenue = gain*multiplier - cost.
        # Hysteresis: boost gain for frontiers near the robot.
        # Skip occupied / out-of-map points (gridValue >= threshold).
        best_revenue = -float('inf')
        best_goal = None
        for ip, c in enumerate(centroids):
            gv = core.gridValue(self.map_data, c)
            if gv >= self._OCCUPIED_THRESHOLD:
                continue
            cost = math.hypot(position[0] - c[0], position[1] - c[1])
            gain = info_gain[ip]
            if cost <= self.hysteresis_radius:
                gain *= self.hysteresis_gain
            revenue = gain * self.info_multiplier - cost
            # Deterministic tie handling: first maximum wins (matches
            # legacy revenue_record.index(max(revenue_record))).
            if revenue > best_revenue:
                best_revenue = revenue
                best_goal = c

        if best_goal is not None:
            self._send_goal(best_goal[0], best_goal[1])
            self.assigned_point = [float(best_goal[0]), float(best_goal[1])]
            self.last_assign_time = self.get_clock().now().nanoseconds / 1e9
            self.get_logger().info(
                'Assigned to [%.3f, %.3f] revenue=%.3f'
                % (best_goal[0], best_goal[1], best_revenue))

        self._publish_status()

    # ------------------------------------------------------------------
    # Shutdown
    # ------------------------------------------------------------------
    def destroy_node(self):
        self.shutting_down = True
        if self.goal_handle is not None:
            try:
                self.goal_handle.cancel_goal_async()
            except Exception:  # pragma: no cover
                pass
            self.goal_handle = None
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = AssignerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
