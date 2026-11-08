FROM ros:jazzy-ros-base@sha256:8eed0a4669bbf43ee331878a4c39bd8ebddea8e3312a58b4fae8edb14526b617
SHELL ["/bin/bash", "-c"]
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3-numpy python3-pytest python3-colcon-common-extensions \
    ros-jazzy-navigation2 ros-jazzy-nav2-bringup ros-jazzy-nav2-minimal-tb3-sim \
    ros-jazzy-slam-toolbox ros-jazzy-tf2-geometry-msgs \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
ENV ROS_DOMAIN_ID=83
ENV GZ_PARTITION=goose-robotics
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV QT_QPA_PLATFORM=offscreen
CMD ["bash"]
