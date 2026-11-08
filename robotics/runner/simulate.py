"""Observe an actual Gazebo/SLAM/Nav2 run. No simulated telemetry is fabricated."""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import time

import rclpy
from rclpy.action import ActionClient
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy, qos_profile_sensor_data, qos_profile_action_status_default
from action_msgs.msg import GoalStatusArray
from nav_msgs.msg import OccupancyGrid, Odometry
from nav2_msgs.action import NavigateToPose
from rosgraph_msgs.msg import Clock
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String
from geometry_msgs.msg import PointStamped
from tf2_ros import Buffer, TransformListener
from lifecycle_msgs.srv import GetState
from nav_status import navigator_publisher,successful_goal_ids


class Observer(Node):
    def __init__(self):
        super().__init__("goose_independent_observer",parameter_overrides=[rclpy.parameter.Parameter("use_sim_time",value=True)])
        self.map_frames=0;self.scans=0;self.clock_first=None;self.clock_last=None;self.path=[];self.status=[];self.map_stats=[];self.frontiers=0;self.latest_map=None
        self.nav2_goal_ids=set();self.nav2_publishers=set();self.nav2_status_ids={};self.nav2_result_requests={};self.nav2_result_statuses={}
        self.tf=Buffer();self.listener=TransformListener(self.tf,self)
        self.nav=ActionClient(self,NavigateToPose,"navigate_to_pose")
        self.nav2_result=self.create_client(NavigateToPose.Impl.GetResultService,"/navigate_to_pose/_action/get_result")
        self.lifecycle=self.create_client(GetState,"/bt_navigator/get_state");self.active=False;self.state_request=None
        self.create_timer(1.,self.check_state)
        self.create_subscription(OccupancyGrid,"/map",self.on_map,QoSProfile(depth=1,reliability=ReliabilityPolicy.RELIABLE,durability=DurabilityPolicy.TRANSIENT_LOCAL))
        self.create_subscription(Odometry,"/odom",self.on_odom,qos_profile_sensor_data)
        self.create_subscription(LaserScan,"/scan",lambda _:setattr(self,"scans",self.scans+1),qos_profile_sensor_data)
        self.create_subscription(Clock,"/clock",self.on_clock,qos_profile_sensor_data)
        self.create_subscription(String,"/goose/exploration_status",self.on_status,10)
        self.create_subscription(PointStamped,"/detected_points",lambda _:setattr(self,"frontiers",self.frontiers+1),10)
        self.create_subscription(GoalStatusArray,"/navigate_to_pose/_action/status",self.on_nav_status,qos_profile_action_status_default)

    def on_nav_status(self,msg,info):
        # Resolve the actual publishing endpoint, rather than accepting the
        # candidate's completion counter or any arbitrary status publisher.
        navigator=navigator_publisher(info,self.get_publishers_info_by_topic("/navigate_to_pose/_action/status"))
        if navigator:self.nav2_publishers.add(navigator)
        observed=successful_goal_ids(msg.status_list,bool(navigator))
        for status in msg.status_list:
            identifier=bytes(status.goal_info.goal_id.uuid).hex()
            if identifier in observed:self.nav2_status_ids[identifier]=status.goal_info.goal_id
        self.check_nav_results()

    def check_nav_results(self):
        if not self.nav2_result.service_is_ready():return
        for identifier,goal_id in self.nav2_status_ids.items():
            if identifier in self.nav2_result_requests:continue
            request=NavigateToPose.Impl.GetResultService.Request();request.goal_id=goal_id
            future=self.nav2_result.call_async(request);self.nav2_result_requests[identifier]=future
            def finished(result_future,identity=identifier):
                try:
                    result=result_future.result();self.nav2_result_statuses[identity]=int(result.status)
                    if result.status==4:self.nav2_goal_ids.add(identity)
                except Exception:self.nav2_result_statuses[identity]="request_failed"
            future.add_done_callback(finished)

    def check_state(self):
        self.check_nav_results()
        if self.lifecycle.service_is_ready() and (self.state_request is None or self.state_request.done()):
            self.state_request=self.lifecycle.call_async(GetState.Request())
            def update(future):
                try:self.active=future.result().current_state.id==3
                except Exception:self.active=False
            self.state_request.add_done_callback(update)

    def on_map(self,msg):
        self.latest_map=msg
        self.map_frames+=1
        self.map_stats.append({"seconds":round(time.monotonic(),2),"known":sum(x>=0 for x in msg.data),"free":sum(x==0 for x in msg.data),"total":len(msg.data),"resolution":float(msg.info.resolution)})

    def on_odom(self,msg):
        pt=[round(msg.pose.pose.position.x,4),round(msg.pose.pose.position.y,4)]
        if not self.path or math.dist(pt,self.path[-1])>=.02:self.path.append(pt)

    def on_clock(self,msg):
        value=msg.clock.sec+msg.clock.nanosec/1e9
        if self.clock_first is None:self.clock_first=value
        self.clock_last=value

    def on_status(self,msg):
        try:self.status.append(json.loads(msg.data))
        except ValueError:self.status.append({"raw":msg.data})

    def baseline_goal(self):
        """Choose a currently observed free cell, with footprint clearance."""
        m=self.latest_map
        if m is None:return None
        try:pose=self.tf.lookup_transform("map","base_link",rclpy.time.Time()).transform.translation
        except Exception:return None
        radius=math.ceil(.20/m.info.resolution);options=[]
        for y in range(radius,m.info.height-radius):
            for x in range(radius,m.info.width-radius):
                if m.data[y*m.info.width+x]!=0:continue
                px=m.info.origin.position.x+(x+.5)*m.info.resolution
                py=m.info.origin.position.y+(y+.5)*m.info.resolution
                distance=math.hypot(px-pose.x,py-pose.y)
                if not .6<distance<1.2:continue
                if any(m.data[(y+dy)*m.info.width+x+dx]!=0 for dx in range(-radius,radius+1) for dy in range(-radius,radius+1)):continue
                options.append((abs(distance-.8)+abs(py-pose.y)*.1,px,py))
        if not options:return None
        _,x,y=min(options);return x,y


def run(seconds,out,baseline_only,external_candidate=False,nonce=""):
    os.environ.setdefault("HOME","/tmp/goose-home")
    os.environ["XDG_RUNTIME_DIR"]="/tmp/goose-xdg"
    Path(os.environ["XDG_RUNTIME_DIR"]).mkdir(mode=0o700,exist_ok=True)
    out.parent.mkdir(parents=True,exist_ok=True)
    handles=[];processes=[]
    def launch(argv,name):
        f=(out.parent/name).open("w");handles.append(f)
        p=subprocess.Popen(argv,stdout=f,stderr=subprocess.STDOUT,start_new_session=True);processes.append(p);return p
    simulation=launch(["ros2","launch","nav2_bringup","tb3_simulation_launch.py","slam:=True","use_rviz:=False","headless:=True","use_composition:=False","autostart:=True"],"gazebo-nav2.log")
    rclpy.init();observer=Observer();start=time.monotonic();exploration=None;goal_sent=False;goal_result=None;ready_at=None;map_tf=False
    try:
        while time.monotonic()-start<seconds:
            rclpy.spin_once(observer,timeout_sec=.1)
            try:
                observer.tf.lookup_transform("map","base_link",rclpy.time.Time());map_tf=True
            except Exception:pass
            ready=observer.map_frames>0 and observer.scans>0 and observer.nav.server_is_ready() and observer.active and map_tf
            if ready and ready_at is None:
                ready_at=round(time.monotonic()-start,2)
                (out.parent/"simulator-ready.json").write_text(json.dumps({"nonce":nonce,"readyAtSeconds":ready_at}))
            if ready and not baseline_only and not external_candidate and exploration is None:
                exploration=launch(["ros2","launch","goose_rrt_exploration","exploration.launch.py","use_sim_time:=True"],"migrated-exploration.log")
            if ready and baseline_only and not goal_sent:
                destination=observer.baseline_goal()
                if destination is None:continue
                goal_sent=True
                goal=NavigateToPose.Goal();goal.pose.header.frame_id="map";goal.pose.header.stamp=observer.get_clock().now().to_msg()
                goal.pose.pose.position.x=destination[0];goal.pose.pose.position.y=destination[1];goal.pose.pose.orientation.w=1.
                def accepted(future):
                    nonlocal goal_result
                    handle=future.result()
                    if not handle.accepted:goal_result="rejected";return
                    def finished(result):
                        nonlocal goal_result
                        goal_result=result.result().status
                    handle.get_result_async().add_done_callback(finished)
                observer.nav.send_goal_async(goal).add_done_callback(accepted)
            if simulation.poll() is not None:break
        distance=sum(math.dist(a,b) for a,b in zip(observer.path,observer.path[1:]))
        if observer.latest_map is not None:
            m=observer.latest_map
            (out.parent/"observed-map.json").write_text(json.dumps({"width":m.info.width,"height":m.info.height,"resolution":m.info.resolution,"origin":[m.info.origin.position.x,m.info.origin.position.y],"data":list(m.data)}))
        reported_completed=max([int(s.get("completed_goals",0)) for s in observer.status]+[0])
        completed=len(observer.nav2_goal_ids)
        checks=[{"name":"Gazebo simulation clock advanced","passed":observer.clock_first is not None and observer.clock_last-observer.clock_first>5},
                {"name":"real lidar scans received","passed":observer.scans>20},
                {"name":"SLAM occupancy maps received","passed":observer.map_frames>0},
                {"name":"map to robot transform available","passed":map_tf},
                {"name":"Nav2 action server ready","passed":observer.nav.server_is_ready()},
                {"name":"robot moved at least 0.25 m in physics","passed":distance>.25}]
        if baseline_only:checks.append({"name":"baseline Nav2 goal succeeded","passed":goal_result==4})
        else:
            checks.extend([{"name":"migrated RRT published frontiers","passed":observer.frontiers>0},
                           {"name":"migrated assignment completed a Nav2 goal","passed":completed>=1}])
            if not external_candidate:checks.append({"name":"migrated package remained running","passed":exploration is not None and exploration.poll() is None})
        report={"kind":"gazebo_physics_baseline" if baseline_only else "migrated_gazebo_mission","world":"Nav2 official TurtleBot3 sandbox","durationWallSeconds":round(time.monotonic()-start,2),
                "simulationSeconds":None if observer.clock_first is None else observer.clock_last-observer.clock_first,"readyAtSeconds":ready_at,
                "lidarMessages":observer.scans,"mapMessages":observer.map_frames,"detectedFrontiers":observer.frontiers,"completedGoals":completed,
                "candidateReportedCompletedGoals":reported_completed,"nav2SucceededGoalIds":sorted(observer.nav2_goal_ids),"nav2ActionStatusPublishers":sorted(observer.nav2_publishers),
                "nav2GetResultStatuses":observer.nav2_result_statuses,
                "completionEvidence":"independent Nav2 GetResult RPC returned SUCCEEDED for unique goal UUIDs discovered from bt_navigator status; candidate counters are supplementary",
                "distanceMeters":round(distance,3),"trajectory":observer.path,"mapHistory":observer.map_stats,"agentStatus":observer.status[-30:],
                "checks":checks,"passed":sum(c["passed"] for c in checks),"total":len(checks),"verdict":"pass" if all(c["passed"] for c in checks) else "fail","nonce":nonce,
                "limitations":["One simulated robot and world; no physical robot validation","No collision certification or full exploration coverage claim","ROS1 baseline is separately recorded source-level replay"]}
        out.write_text(json.dumps(report,indent=2)+"\n")
        print(json.dumps({k:report[k] for k in ["kind","verdict","passed","total","readyAtSeconds","distanceMeters","completedGoals"]}))
        return report["verdict"]=="pass"
    finally:
        observer.destroy_node();rclpy.shutdown()
        for p in reversed(processes):
            if p.poll() is None:
                os.killpg(p.pid,signal.SIGINT)
                try:p.wait(timeout=10)
                except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
        for f in handles:f.close()


if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--seconds",type=int,default=180);parser.add_argument("--out",type=Path,required=True);parser.add_argument("--baseline-only",action="store_true");parser.add_argument("--external-candidate",action="store_true");parser.add_argument("--nonce",default="")
    args=parser.parse_args();raise SystemExit(0 if run(args.seconds,args.out,args.baseline_only,args.external_candidate,args.nonce) else 1)
