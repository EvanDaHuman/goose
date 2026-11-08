// src/rrt_detector.cpp
//
// MIT License
//
// Copyright (c) 2016 The rrt_exploration authors
// (original ROS1 package: https://github.com/hasauino/rrt_exploration)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// ROS2 Jazzy migration of global_rrt_detector.cpp + functions.cpp
// for the goose_rrt_exploration package.
//
// Algorithm preserved from the original MIT rrt_exploration source:
//   - RRT samples uniformly in the map region, grows toward unknown cells.
//   - When ObstacleFree returns -1 (unknown/frontier), the point is published
//     on /detected_points as geometry_msgs/PointStamped.
//   - When ObstacleFree returns 1 (free), the node is added to the RRT tree.
//   - ObstacleFree returns 0 (occupied) and the sample is discarded.
//
// Changes for ROS2:
//   - Blocking while-loops replaced by a bounded timer callback.
//   - /map subscribed with transient_local QoS to match latched publishers.
//   - Frame ids normalized (no leading slash).
//   - Fallback initialization from map bounds + TF robot position when
//     /clicked_point is not used.
//   - Configurable parameters: eta, map_topic, points_topic, robot_frame,
//     global_frame, max_goals, random_seed, use_sim_time.
//   - std::mt19937 replaces MTRand.

#include <rclcpp/rclcpp.hpp>
#include <nav_msgs/msg/occupancy_grid.hpp>
#include <geometry_msgs/msg/point_stamped.hpp>
#include <geometry_msgs/msg/point.hpp>
#include <visualization_msgs/msg/marker.hpp>
#include <tf2_ros/buffer.h>
#include <tf2_ros/transform_listener.h>
#include <tf2/exceptions.h>
#include <tf2/time.h>

#include <cmath>
#include <vector>
#include <string>
#include <random>
#include <chrono>

using namespace std::chrono_literals;

// ============================================================================
// Helper functions ported from src/functions.cpp (MIT, rrt_exploration)
// ============================================================================

// Norm: Euclidean distance between two 2-D points represented as vectors.
static float Norm(const std::vector<float> & x1, const std::vector<float> & x2)
{
  float dx = x2[0] - x1[0];
  float dy = x2[1] - x1[1];
  return std::sqrt(dx * dx + dy * dy);
}

// sign: returns -1 for negative, +1 otherwise (original semantics).
static float sign(float n)
{
  if (n < 0.0f) {
    return -1.0f;
  }
  return 1.0f;
}

// Nearest: returns the vertex in V closest to x (original linear search).
static std::vector<float> Nearest(
  const std::vector<std::vector<float>> & V,
  const std::vector<float> & x)
{
  float min_val = Norm(V[0], x);
  int min_index = 0;
  for (int j = 0; j < static_cast<int>(V.size()); ++j) {
    float temp = Norm(V[j], x);
    if (temp <= min_val) {
      min_val = temp;
      min_index = j;
    }
  }
  return V[min_index];
}

// Steer: move from x_nearest toward x_rand by at most eta.
// Preserves the original formula including the vertical-line special case.
static std::vector<float> Steer(
  const std::vector<float> & x_nearest,
  const std::vector<float> & x_rand,
  float eta)
{
  std::vector<float> x_new;

  if (Norm(x_nearest, x_rand) <= eta) {
    x_new = x_rand;
  } else {
    float m = (x_rand[1] - x_nearest[1]) / (x_rand[0] - x_nearest[0]);
    x_new.push_back(
      sign(x_rand[0] - x_nearest[0]) *
      std::sqrt((eta * eta) / ((m * m) + 1.0f)) + x_nearest[0]);
    x_new.push_back(m * (x_new[0] - x_nearest[0]) + x_nearest[1]);

    // Vertical line special case (original fix-up).
    if (x_rand[0] == x_nearest[0]) {
      x_new[0] = x_nearest[0];
      x_new[1] = x_nearest[1] + eta;
    }
  }
  return x_new;
}

// gridValue: occupancy value at world-coordinate Xp.
//   100 = occupied, -1 = unknown, 0 = free.
// Bounds-checked: returns 100 for out-of-bounds or invalid-map coordinates,
// preventing negative indexing and row wrap-around.
static int gridValue(
  const nav_msgs::msg::OccupancyGrid & mapData,
  const std::vector<float> & Xp)
{
  float resolution = mapData.info.resolution;
  if (resolution <= 0.0f) {
    return 100;  // invalid map resolution → treat as occupied
  }

  float Xstartx = mapData.info.origin.position.x;
  float Xstarty = mapData.info.origin.position.y;
  int width = static_cast<int>(mapData.info.width);
  int height = static_cast<int>(mapData.info.height);

  int indx_x = static_cast<int>(std::floor((Xp[0] - Xstartx) / resolution));
  int indx_y = static_cast<int>(std::floor((Xp[1] - Xstarty) / resolution));

  // Safe coordinate bounds: out-of-bounds → occupied.
  if (indx_x < 0 || indx_x >= width || indx_y < 0 || indx_y >= height) {
    return 100;
  }

  int indx = indx_y * width + indx_x;
  if (indx < 0 || indx >= static_cast<int>(mapData.data.size())) {
    return 100;
  }

  return static_cast<int>(mapData.data[indx]);
}

// ObstacleFree: checks the path from xnear to xnew.
//   Returns  1 if the path is free.
//   Returns -1 if an unknown cell is hit (frontier candidate).
//   Returns  0 if an occupied cell is hit (obstacle).
// xnew is updated to the last checked position (original behaviour).
static int ObstacleFree(
  std::vector<float> xnear,
  std::vector<float> & xnew,
  const nav_msgs::msg::OccupancyGrid & mapsub)
{
  if (mapsub.info.resolution <= 0.0f) {
    return 0;
  }

  float rez = static_cast<float>(mapsub.info.resolution) * 0.2f;
  // Original: float stepz = int(ceil(Norm(xnew,xnear))/rez);
  float stepz = static_cast<float>(
    static_cast<int>(std::ceil(Norm(xnew, xnear)) / rez));

  std::vector<float> xi = xnear;
  int obs = 0;
  int unk = 0;

  for (int c = 0; c < static_cast<int>(stepz); ++c) {
    xi = Steer(xi, xnew, rez);

    if (gridValue(mapsub, xi) == 100) {
      obs = 1;
    }
    if (gridValue(mapsub, xi) == -1) {
      unk = 1;
      break;
    }
  }

  int out = 0;
  xnew = xi;
  if (unk == 1) {
    out = -1;
  }
  if (obs == 1) {
    out = 0;
  }
  if (obs != 1 && unk != 1) {
    out = 1;
  }
  return out;
}

// ============================================================================
// RRtDetector node — ROS2 timer-driven RRT frontier detector.
// ============================================================================

class RRtDetector : public rclcpp::Node
{
public:
  RRtDetector()
  : rclcpp::Node("rrt_detector"),
    tf_buffer_(get_clock()),
    tf_listener_(tf_buffer_)
  {
    // ---- Declare parameters ----
    declare_parameter("eta", 0.5);
    declare_parameter("map_topic", "/map");
    declare_parameter("points_topic", "/detected_points");
    declare_parameter("robot_frame", "base_link");
    declare_parameter("global_frame", "map");
    declare_parameter("max_goals", -1);  // -1 = unlimited
    declare_parameter("random_seed", 0);  //  0 = non-deterministic
    // use_sim_time is built into ROS2 Node — not redeclared.

    eta_ = static_cast<float>(get_parameter("eta").as_double());
    map_topic_ = get_parameter("map_topic").as_string();
    points_topic_ = get_parameter("points_topic").as_string();
    robot_frame_ = get_parameter("robot_frame").as_string();
    global_frame_ = get_parameter("global_frame").as_string();
    max_goals_ = get_parameter("max_goals").as_int();
    int seed = get_parameter("random_seed").as_int();

    if (seed != 0) {
      rng_.seed(static_cast<std::mt19937::result_type>(seed));
    }

    // ---- Subscribers ----
    // /map: transient_local + reliable to receive the latched SLAM map.
    rclcpp::QoS map_qos(rclcpp::KeepLast(1));
    map_qos.transient_local();
    map_qos.reliable();

    map_sub_ = create_subscription<nav_msgs::msg::OccupancyGrid>(
      map_topic_, map_qos,
      std::bind(&RRtDetector::mapCallback, this, std::placeholders::_1));

    // /clicked_point: user-provided initialization points (original behaviour).
    clicked_sub_ = create_subscription<geometry_msgs::msg::PointStamped>(
      "/clicked_point", 10,
      std::bind(&RRtDetector::clickedCallback, this, std::placeholders::_1));

    // ---- Publishers ----
    points_pub_ = create_publisher<geometry_msgs::msg::PointStamped>(
      points_topic_, 10);

    marker_pub_ = create_publisher<visualization_msgs::msg::Marker>(
      "~/shapes", 10);

    // ---- Bounded timer (100 Hz, matching original ros::Rate(100)) ----
    timer_ = create_wall_timer(
      10ms, std::bind(&RRtDetector::timerCallback, this));
  }

  ~RRtDetector() override
  {
    // Stop dispatching on shutdown.
    if (timer_) {
      timer_->cancel();
    }
  }

private:
  // ------------------------------------------------------------------
  // Callbacks
  // ------------------------------------------------------------------

  void mapCallback(const nav_msgs::msg::OccupancyGrid::SharedPtr msg)
  {
    mapData_ = *msg;
    // Normalize frame id: strip leading slash (ROS2 TF convention).
    if (!mapData_.header.frame_id.empty() && mapData_.header.frame_id[0] == '/') {
      mapData_.header.frame_id = mapData_.header.frame_id.substr(1);
    }
    have_map_ = true;
  }

  void clickedCallback(const geometry_msgs::msg::PointStamped::SharedPtr msg)
  {
    geometry_msgs::msg::Point p;
    p.x = msg->point.x;
    p.y = msg->point.y;
    p.z = msg->point.z;
    clicked_points_.push_back(p);
  }

  // ------------------------------------------------------------------
  // Timer-driven RRT loop (non-blocking)
  // ------------------------------------------------------------------

  void timerCallback()
  {
    // Wait until a valid map is available.
    if (!have_map_ || mapData_.data.empty()) {
      return;
    }

    // One-time initialization.
    if (!initialized_) {
      tryInitialize();
      if (!initialized_) {
        return;
      }
      initMarkers();
    }

    // Respect max_goals limit.
    if (max_goals_ > 0 && goals_published_ >= max_goals_) {
      return;
    }

    rrtStep();
  }

  void tryInitialize()
  {
    // Original path: need 5 clicked points for map region + initial root.
    if (clicked_points_.size() >= 5) {
      initFromClickedPoints();
      initialized_ = true;
      return;
    }

    // Fallback path: after a bounded wait, initialise from map bounds.
    if (!init_attempt_started_) {
      init_attempt_start_ = now();
      init_attempt_started_ = true;
      return;
    }

    double elapsed = (now() - init_attempt_start_).seconds();
    if (elapsed < 5.0) {
      // Give /clicked_point a chance to arrive.
      return;
    }

    initFromMapOrTf();
    initialized_ = true;
  }

  void initFromClickedPoints()
  {
    // Compute sampling-region dimensions from the first and third clicked
    // points (original global_rrt_detector.cpp logic).
    std::vector<float> temp1, temp2;

    temp1 = {clicked_points_[0].x, clicked_points_[0].y};
    temp2 = {clicked_points_[2].x, clicked_points_[0].y};
    init_map_x_ = Norm(temp1, temp2);

    temp1 = {clicked_points_[0].x, clicked_points_[0].y};
    temp2 = {clicked_points_[0].x, clicked_points_[2].y};
    init_map_y_ = Norm(temp1, temp2);

    Xstartx_ = (clicked_points_[0].x + clicked_points_[2].x) * 0.5f;
    Xstarty_ = (clicked_points_[0].y + clicked_points_[2].y) * 0.5f;

    // Fifth clicked point = initial RRT tree root.
    std::vector<float> xnew = {clicked_points_[4].x, clicked_points_[4].y};
    V_.push_back(xnew);

    clicked_points_.clear();
  }

  void initFromMapOrTf()
  {
    // Use the full map extent as the sampling region.
    init_map_x_ = static_cast<float>(mapData_.info.width) *
                  static_cast<float>(mapData_.info.resolution);
    init_map_y_ = static_cast<float>(mapData_.info.height) *
                  static_cast<float>(mapData_.info.resolution);
    Xstartx_ = static_cast<float>(mapData_.info.origin.position.x) +
               init_map_x_ * 0.5f;
    Xstarty_ = static_cast<float>(mapData_.info.origin.position.y) +
               init_map_y_ * 0.5f;

    // Try to seed the tree at the robot's current position via TF.
    std::vector<float> xnew;
    try {
      auto tf = tf_buffer_.lookupTransform(
        global_frame_, robot_frame_,
        tf2::TimePointZero,
        tf2::Duration(std::chrono::milliseconds(100)));
      xnew = {
        static_cast<float>(tf.transform.translation.x),
        static_cast<float>(tf.transform.translation.y)};
    } catch (const tf2::TransformException &) {
      // TF unavailable: fall back to map centre.
      xnew = {Xstartx_, Xstarty_};
    }
    V_.push_back(xnew);
  }

  void initMarkers()
  {
    // Visualization markers — mirrors the original global_rrt_detector.cpp.
    points_marker_.header.frame_id = mapData_.header.frame_id;
    line_marker_.header.frame_id = mapData_.header.frame_id;
    points_marker_.ns = "markers";
    line_marker_.ns = "markers";
    points_marker_.id = 0;
    line_marker_.id = 1;
    points_marker_.type = visualization_msgs::msg::Marker::POINTS;
    line_marker_.type = visualization_msgs::msg::Marker::LINE_LIST;
    points_marker_.action = visualization_msgs::msg::Marker::ADD;
    line_marker_.action = visualization_msgs::msg::Marker::ADD;
    points_marker_.pose.orientation.w = 1.0;
    line_marker_.pose.orientation.w = 1.0;
    line_marker_.scale.x = 0.03;
    line_marker_.scale.y = 0.03;
    points_marker_.scale.x = 0.3;
    points_marker_.scale.y = 0.3;
    line_marker_.color.r = 9.0 / 255.0;
    line_marker_.color.g = 91.0 / 255.0;
    line_marker_.color.b = 236.0 / 255.0;
    line_marker_.color.a = 1.0;
    points_marker_.color.r = 1.0;
    points_marker_.color.g = 0.0;
    points_marker_.color.b = 0.0;
    points_marker_.color.a = 1.0;
    // Zero duration = persistent (original ros::Duration()).
    points_marker_.lifetime.sec = 0;
    points_marker_.lifetime.nanosec = 0;
    line_marker_.lifetime.sec = 0;
    line_marker_.lifetime.nanosec = 0;
  }

  void rrtStep()
  {
    if (V_.empty()) {
      return;
    }

    // ---- Sample: uniform in [Xstart - dim/2, Xstart + dim/2] ----
    float xr = dist_(rng_) * init_map_x_ - init_map_x_ * 0.5f + Xstartx_;
    float yr = dist_(rng_) * init_map_y_ - init_map_y_ * 0.5f + Xstarty_;
    std::vector<float> x_rand = {xr, yr};

    // ---- Nearest ----
    std::vector<float> x_nearest = Nearest(V_, x_rand);

    // ---- Steer ----
    std::vector<float> x_new = Steer(x_nearest, x_rand, eta_);

    // ---- ObstacleFree:  1=free  -1=unknown(frontier)  0=obstacle ----
    int checking = ObstacleFree(x_nearest, x_new, mapData_);

    if (checking == -1) {
      // Frontier detected → publish detected point.
      geometry_msgs::msg::PointStamped exploration_goal;
      exploration_goal.header.stamp = now();
      exploration_goal.header.frame_id = mapData_.header.frame_id;
      exploration_goal.point.x = x_new[0];
      exploration_goal.point.y = x_new[1];
      exploration_goal.point.z = 0.0;
      points_pub_->publish(exploration_goal);
      goals_published_++;

      // Publish single-point marker (original: push, publish, clear).
      geometry_msgs::msg::Point p;
      p.x = x_new[0];
      p.y = x_new[1];
      p.z = 0.0;
      points_marker_.points.push_back(p);
      points_marker_.header.stamp = now();
      marker_pub_->publish(points_marker_);
      points_marker_.points.clear();
    } else if (checking == 1) {
      // Free space → extend the tree.
      V_.push_back(x_new);

      // Add edge to line marker (new point + nearest point).
      geometry_msgs::msg::Point p;
      p.x = x_new[0];
      p.y = x_new[1];
      p.z = 0.0;
      line_marker_.points.push_back(p);
      p.x = x_nearest[0];
      p.y = x_nearest[1];
      p.z = 0.0;
      line_marker_.points.push_back(p);
    }

    // Publish line marker every iteration (original behaviour).
    line_marker_.header.stamp = now();
    marker_pub_->publish(line_marker_);
  }

  // ------------------------------------------------------------------
  // Member variables
  // ------------------------------------------------------------------

  // Parameters
  float eta_;
  std::string map_topic_;
  std::string points_topic_;
  std::string robot_frame_;
  std::string global_frame_;
  int max_goals_;

  // Map state
  nav_msgs::msg::OccupancyGrid mapData_;
  bool have_map_ = false;

  // Initialization state
  bool initialized_ = false;
  bool init_attempt_started_ = false;
  rclcpp::Time init_attempt_start_;
  int goals_published_ = 0;
  std::vector<geometry_msgs::msg::Point> clicked_points_;

  // RRT tree and sampling region
  std::vector<std::vector<float>> V_;
  float init_map_x_ = 0.0f;
  float init_map_y_ = 0.0f;
  float Xstartx_ = 0.0f;
  float Xstarty_ = 0.0f;

  // RNG (replaces MTRand)
  std::mt19937 rng_;
  std::uniform_real_distribution<float> dist_{0.0f, 1.0f};

  // TF
  tf2_ros::Buffer tf_buffer_;
  tf2_ros::TransformListener tf_listener_;

  // ROS2 interfaces
  rclcpp::Subscription<nav_msgs::msg::OccupancyGrid>::SharedPtr map_sub_;
  rclcpp::Subscription<geometry_msgs::msg::PointStamped>::SharedPtr clicked_sub_;
  rclcpp::Publisher<geometry_msgs::msg::PointStamped>::SharedPtr points_pub_;
  rclcpp::Publisher<visualization_msgs::msg::Marker>::SharedPtr marker_pub_;
  rclcpp::TimerBase::SharedPtr timer_;

  // Visualization markers
  visualization_msgs::msg::Marker points_marker_;
  visualization_msgs::msg::Marker line_marker_;
};

// ============================================================================
// Main
// ============================================================================

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<RRtDetector>());
  rclcpp::shutdown();
  return 0;
}
