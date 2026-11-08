#!/usr/bin/env python3
# core.py -- Pure-Python geometry / utility functions for the RRT
# exploration migration (ROS 2 Jazzy, package goose_rrt_exploration).
#
# This module is intentionally importable WITHOUT ROS or numpy.
# All public functions return plain Python numbers / lists.
#
# MIT License -- original RRT exploration library:
# Copyright (c) 2016 H. Azmandian, M. Kantar, Y. Iwamoto, and R. Parasuraman,
# "RRT-based Frontier Exploration for Multiple Robots", IEEE/RSJ IROS 2016.
# Licensed under the MIT License (see package README.md for full text).
#
# Authorized migration changes vs. legacy functions.py:
#   * numpy replaced with stdlib math (importable without numpy)
#   * Python2 integer division corrected to Python3 //
#   * Safe coordinate bounds (gridValue outside -> 100)
#   * Zero / invalid map-resolution validation
#   * No negative indexing or row-wrap at invalid coordinates
#   * Empty-input bounds added
#   * point_of_index returns plain [x, y]
#   * New select_goal() implementing info-gain - travel-cost + hysteresis

import math

# OccupancyGrid convention: -1 unknown, 0 free, 100 occupied.
# Cells with value >= this threshold are treated as occupied.
_OCCUPIED_THRESHOLD = 50

# ---------------------------------------------------------------------------
# internal helpers
# ---------------------------------------------------------------------------


def _dist(a, b):
    """Euclidean distance between two [x, y] points."""
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return math.sqrt(dx * dx + dy * dy)


def _valid_resolution(mapData):
    """Return map resolution if valid (> 0), otherwise None."""
    r = getattr(mapData.info, 'resolution', None)
    if r is None or r <= 0:
        return None
    return r


def _in_bounds(mapData, Xp):
    """True if world point *Xp* lies inside the map grid extent."""
    r = _valid_resolution(mapData)
    if r is None:
        return False
    col = int(math.floor((Xp[0] - mapData.info.origin.position.x) / r))
    row = int(math.floor((Xp[1] - mapData.info.origin.position.y) / r))
    return 0 <= col < mapData.info.width and 0 <= row < mapData.info.height


def _point_xy(p):
    """Extract [x, y] from a path element.

    Accepts ROS PoseStamped (``p.pose.position.x``), a bare Point-like
    object (``p.x``), or a plain list / tuple ``[x, y]``.
    """
    if hasattr(p, 'pose') and hasattr(p.pose, 'position'):
        return [p.pose.position.x, p.pose.position.y]
    if hasattr(p, 'x') and hasattr(p, 'y'):
        return [p.x, p.y]
    if isinstance(p, (list, tuple)):
        return [float(p[0]), float(p[1])]
    return [0.0, 0.0]


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------


def index_of_point(mapData, Xp):
    """Return the flat cell index for world point *Xp*.

    Returns -1 when the map resolution is invalid.
    """
    resolution = _valid_resolution(mapData)
    if resolution is None:
        return -1
    Xstartx = mapData.info.origin.position.x
    Xstarty = mapData.info.origin.position.y
    width = mapData.info.width
    index = int((math.floor((Xp[1] - Xstarty) / resolution) * width) +
                (math.floor((Xp[0] - Xstartx) / resolution)))
    return index


def point_of_index(mapData, i):
    """Return cell-corner [x, y] coordinates for flat index *i*.

    Preserves the original Python2 integer-division semantics:
    ``row = i // width``.
    """
    resolution = _valid_resolution(mapData)
    if resolution is None:
        return [0.0, 0.0]
    width = mapData.info.width
    row = i // width
    y = mapData.info.origin.position.y + row * resolution
    x = mapData.info.origin.position.x + (i - row * width) * resolution
    return [x, y]


def informationGain(mapData, point, r):
    """Count unknown cells (value -1) within radius *r* of *point*.

    Returns the count multiplied by ``resolution ** 2`` (cell area).
    Returns 0 when the map resolution is invalid.
    """
    resolution = _valid_resolution(mapData)
    if resolution is None:
        return 0
    data = mapData.data
    width = mapData.info.width
    infoGain = 0
    index = index_of_point(mapData, point)
    r_region = int(r / resolution)
    init_index = index - r_region * (width + 1)
    for n in range(0, 2 * r_region + 1):
        start = n * width + init_index
        end = start + 2 * r_region
        limit = ((start // width) + 2) * width
        for i in range(start, end + 1):
            if i >= 0 and i < limit and i < len(data):
                if data[i] == -1:
                    cell = point_of_index(mapData, i)
                    if _dist(point, cell) <= r:
                        infoGain += 1
    return infoGain * (resolution ** 2)


def discount(mapData, assigned_pt, centroids, infoGain, r):
    """Reduce ``infoGain[j]`` by 1 for each unknown cell shared between
    ``centroids[j]`` and *assigned_pt* within radius *r*.

    The discount reflects the fact that exploring the assigned point
    will reveal some of the same unknown cells counted by nearby
    centroids, so their information gain should be reduced.

    Modifies and returns the *infoGain* list in place.
    """
    resolution = _valid_resolution(mapData)
    if resolution is None:
        return infoGain
    if not centroids:
        return infoGain
    data = mapData.data
    width = mapData.info.width
    index = index_of_point(mapData, assigned_pt)
    r_region = int(r / resolution)
    init_index = index - r_region * (width + 1)
    for n in range(0, 2 * r_region + 1):
        start = n * width + init_index
        end = start + 2 * r_region
        limit = ((start // width) + 2) * width
        for i in range(start, end + 1):
            if i >= 0 and i < limit and i < len(data):
                for j in range(0, len(centroids)):
                    if data[i] == -1:
                        cell = point_of_index(mapData, i)
                        if (_dist(cell, centroids[j]) <= r and
                                _dist(cell, assigned_pt) <= r):
                            infoGain[j] -= 1
    return infoGain


def gridValue(mapData, Xp):
    """Return the occupancy value at world point *Xp*.

    Map data convention:  ``100`` occupied, ``-1`` unknown, ``0`` free.
    Returns ``100`` for out-of-bounds or invalid coordinates.
    """
    resolution = _valid_resolution(mapData)
    if resolution is None:
        return 100
    Xstartx = mapData.info.origin.position.x
    Xstarty = mapData.info.origin.position.y
    width = mapData.info.width
    data = mapData.data
    index = int((math.floor((Xp[1] - Xstarty) / resolution) * width) +
                (math.floor((Xp[0] - Xstartx) / resolution)))
    if 0 <= index < len(data):
        return data[index]
    return 100


def pathCost(path):
    """Approximate path cost from a list of path elements.

    Original algorithm: Euclidean length of the midpoint segment
    multiplied by ``(len(path) - 1)``.

    Returns ``inf`` for an empty path.
    """
    if path is None or len(path) == 0:
        return float('inf')
    i = len(path) // 2
    p1 = _point_xy(path[i - 1])
    p2 = _point_xy(path[i])
    dx = p1[0] - p2[0]
    dy = p1[1] - p2[1]
    return math.sqrt(dx * dx + dy * dy) * (len(path) - 1)


def select_goal(mapData, position, frontiers, info_radius=1.0,
                info_multiplier=3.0, hysteresis_radius=3.0,
                hysteresis_gain=2.0):
    """Choose the best frontier to explore.

    Algorithm:
      1. Ignore out-of-map and occupied frontiers.
      2. Compute information gain for each valid frontier.
      3. Discount gains of frontiers whose unknown cells overlap
         with the robot's current neighbourhood.
      4. Score = ``discounted_infoGain * info_multiplier - travel_cost``
         where travel cost is the Euclidean distance from *position*.
      5. Add *hysteresis_gain* to frontiers within *hysteresis_radius*
         of the robot (prevents rapid goal switching).
      6. Select the maximum score with deterministic tie handling
         (lowest list index wins on ties).

    Returns the chosen ``[x, y]`` or ``None`` if no valid frontier exists.
    """
    if not frontiers:
        return None
    if not _valid_resolution(mapData):
        return None

    # -- Build the valid frontier list with info gains ----------------------
    valid_frontiers = []
    info_gains = []
    for frontier in frontiers:
        if not _in_bounds(mapData, frontier):
            continue
        gv = gridValue(mapData, frontier)
        if gv >= _OCCUPIED_THRESHOLD:
            continue
        ig = informationGain(mapData, frontier, info_radius)
        valid_frontiers.append(frontier)
        info_gains.append(ig)

    if not valid_frontiers:
        return None

    # -- Discount gains of frontiers overlapping the robot's area -----------
    info_gains = discount(mapData, position, valid_frontiers,
                          info_gains, info_radius)

    # -- Score and select ---------------------------------------------------
    best_score = None
    best_idx = 0
    for idx in range(len(valid_frontiers)):
        frontier = valid_frontiers[idx]
        travel_cost = _dist(frontier, position)
        score = info_gains[idx] * info_multiplier - travel_cost
        if travel_cost <= hysteresis_radius:
            score += hysteresis_gain
        if best_score is None or score > best_score:
            best_score = score
            best_idx = idx

    chosen = valid_frontiers[best_idx]
    return [chosen[0], chosen[1]]
