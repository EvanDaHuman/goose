# Copyright (c) Hassan Umari, MIT License (original rrt_exploration).
# ROS2 Jazzy migration: launch the RRT exploration pipeline.
#
# Brings up three nodes against an existing Nav2 stack and SLAM /map:
#   - rrt_detector (C++): samples free/unknown frontiers -> /detected_points
#   - filter.py:     prunes invalid/occupied/low-info candidates -> /filtered_points
#   - assigner.py:   information-gain-minus-cost selection -> NavigateToPose
#
# All topics, frames, and limits are configurable via launch arguments.
"""Launch file for the goose_rrt_exploration pipeline."""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    # Configurable parameters (defaults match the cross-file contract).
    use_sim_time = LaunchConfiguration('use_sim_time')
    map_topic = LaunchConfiguration('map_topic')
    points_topic = LaunchConfiguration('points_topic')
    frontiers_topic = LaunchConfiguration('frontiers_topic')
    global_frame = LaunchConfiguration('global_frame')
    robot_frame = LaunchConfiguration('robot_frame')
    max_goals = LaunchConfiguration('max_goals')
    random_seed = LaunchConfiguration('random_seed')
    info_radius = LaunchConfiguration('info_radius')
    info_multiplier = LaunchConfiguration('info_multiplier')
    hysteresis_radius = LaunchConfiguration('hysteresis_radius')
    hysteresis_gain = LaunchConfiguration('hysteresis_gain')
    rate = LaunchConfiguration('rate')

    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='true'),
        DeclareLaunchArgument('map_topic', default_value='/map'),
        DeclareLaunchArgument('points_topic', default_value='/detected_points'),
        DeclareLaunchArgument('frontiers_topic', default_value='/filtered_points'),
        DeclareLaunchArgument('global_frame', default_value='map'),
        DeclareLaunchArgument('robot_frame', default_value='base_link'),
        DeclareLaunchArgument('max_goals', default_value='0'),
        DeclareLaunchArgument('random_seed', default_value='0'),
        DeclareLaunchArgument('info_radius', default_value='1.0'),
        DeclareLaunchArgument('info_multiplier', default_value='3.0'),
        DeclareLaunchArgument('hysteresis_radius', default_value='3.0'),
        DeclareLaunchArgument('hysteresis_gain', default_value='2.0'),
        DeclareLaunchArgument('rate', default_value='1.0'),

        # RRT frontier detector (C++ executable).
        Node(
            package='goose_rrt_exploration',
            executable='rrt_detector',
            name='rrt_detector',
            output='screen',
            parameters=[{
                'use_sim_time': use_sim_time,
                'map_topic': map_topic,
                'points_topic': points_topic,
                'global_frame': global_frame,
                'random_seed': random_seed,
                'rate': rate,
            }],
        ),

        # Frontier filter (Python executable).
        Node(
            package='goose_rrt_exploration',
            executable='filter.py',
            name='filter',
            output='screen',
            parameters=[{
                'use_sim_time': use_sim_time,
                'map_topic': map_topic,
                'points_topic': points_topic,
                'frontiers_topic': frontiers_topic,
                'global_frame': global_frame,
            }],
        ),

        # Goal assigner driving Nav2 NavigateToPose (Python executable).
        Node(
            package='goose_rrt_exploration',
            executable='assigner.py',
            name='assigner',
            output='screen',
            parameters=[{
                'use_sim_time': use_sim_time,
                'map_topic': map_topic,
                'frontiers_topic': frontiers_topic,
                'global_frame': global_frame,
                'robot_frame': robot_frame,
                'max_goals': max_goals,
                'info_radius': info_radius,
                'info_multiplier': info_multiplier,
                'hysteresis_radius': hysteresis_radius,
                'hysteresis_gain': hysteresis_gain,
                'rate': rate,
            }],
        ),
    ])
