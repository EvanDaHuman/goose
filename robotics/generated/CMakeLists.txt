cmake_minimum_required(VERSION 3.8)
project(goose_rrt_exploration)

# Original package: rrt_exploration by Hassan Umari (MIT License).
# Migrated from ROS1/catkin to ROS2 Jazzy (ament_cmake).

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "GNU")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(std_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(visualization_msgs REQUIRED)
find_package(tf2 REQUIRED)
find_package(tf2_ros REQUIRED)
find_package(rosidl_default_generators REQUIRED)

# Generate the PointArray message interface.
# PointArray.msg references geometry_msgs/Point[].
rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/PointArray.msg"
  DEPENDENCIES geometry_msgs
)

# C++ RRT frontier detector node -> executable rrt_detector.
# Publishes /detected_points (geometry_msgs/PointStamped), consumes /map.
add_executable(rrt_detector src/rrt_detector.cpp)
ament_target_dependencies(rrt_detector
  rclcpp
  std_msgs
  geometry_msgs
  nav_msgs
  visualization_msgs
  tf2
  tf2_ros
)

install(TARGETS rrt_detector
  DESTINATION lib/${PROJECT_NAME}
)

# Python nodes (filter.py, assigner.py) are executable entry points.
# core.py is imported by both as a plain module ("import core"), so it is
# installed beside them in the same lib directory.
install(PROGRAMS
  scripts/filter.py
  scripts/assigner.py
  scripts/core.py
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY launch
  DESTINATION share/${PROJECT_NAME}
)

ament_package()
