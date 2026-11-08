# goose_rrt_exploration

ROS2 Jazzy migration of the MIT-licensed **rrt_exploration** package by
Hassan Umari, targeting a single differential-drive robot that explores an
unknown map using RRT-based frontier detection, frontier filtering, and an
information-gain goal assigner driving an existing Nav2 `NavigateToPose`
action server.

## Attribution

Original work: **rrt_exploration** by Hassan Umari (`oh91@windowslive.com`),
licensed under the MIT License. See `http://wiki.ros.org/rrt_exploration`.
This package preserves the original algorithm concepts (RRT frontier sampling
in free/unknown space, frontier filtering, information-gain minus travel-cost
selection with hysteresis) while porting the ROS1/catkin implementation to
ROS2 Jazzy (`ament_cmake`).

## Requirements

- ROS2 Jazzy
- An existing Nav2 stack providing a `NavigateToPose` action server
- An existing SLAM source publishing `/map` (`nav_msgs/OccupancyGrid`) with
  `transient_local` QoS
- A `tf2` tree providing `map -> base_link`
- Python: `numpy` and the standard library only (no scikit-learn)

## Nodes

| Executable | Language | Subscribes | Publishes |
|---|---|---|---|
| `rrt_detector` | C++ | `/map` | `/detected_points` (`geometry_msgs/PointStamped`) |
| `filter.py` | Python | `/map`, `/detected_points` | `/filtered_points` (`goose_rrt_exploration/PointArray`) |
| `assigner.py` | Python | `/filtered_points`, `/map`, `tf map->base_link`, `NavigateToPose` | `/goose/exploration_status` (`std_msgs/String` JSON), Nav2 goals |

`scripts/core.py` is a pure-Python helper (importable without ROS or numpy)
that implements the core algorithm functions shared by the Python nodes.

## Message

```
goose_rrt_exploration/PointArray
  geometry_msgs/Point[] points
```

## Launch

```bash
ros2 launch goose_rrt_exploration exploration.launch.py
```

### Configurable launch arguments

| Argument | Default | Description |
|---|---|---|
| `use_sim_time` | `true` | Use simulation clock |
| `map_topic` | `/map` | OccupancyGrid input topic |
| `points_topic` | `/detected_points` | Raw frontier candidates topic |
| `frontiers_topic` | `/filtered_points` | Filtered frontiers topic |
| `global_frame` | `map` | Fixed/world frame |
| `robot_frame` | `base_link` | Robot base frame |
| `max_goals` | `0` | Max goals before stopping (0 = unlimited) |
| `random_seed` | `0` | RRT detector random seed (0 = random) |
| `info_radius` | `1.0` | Information-gain radius (cells) |
| `info_multiplier` | `3.0` | Gain weight vs. travel cost |
| `hysteresis_radius` | `3.0` | Hysteresis proximity radius |
| `hysteresis_gain` | `2.0` | Hysteresis bonus |
| `rate` | `1.0` | Dispatch loop rate (Hz) |

## Build

```bash
colcon build --packages-select goose_rrt_exploration
```

## License

MIT (original by Hassan Umari).
