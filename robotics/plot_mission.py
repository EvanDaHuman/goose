#!/usr/bin/env python3
"""Render an SVG from recorded physics telemetry, without inventing robot motion."""
import argparse
import hashlib
import html
import json
from pathlib import Path


def render(report_path, output):
    report=json.loads(report_path.read_text())
    capture=report.get("mapArtifact")
    if not capture:raise ValueError("Mission report has no bound map artifact")
    # Evidence remains portable when the report and map are copied together.
    companions=[report_path.parent/"observed-map.json",report_path.parent/"robotics-map.json"]
    map_path=next((p for p in companions if p.exists()),Path(capture["path"]))
    raw=map_path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=capture["sha256"]:raise ValueError("Map artifact hash mismatch")
    grid=json.loads(raw);points=report.get("trajectory",[])
    if not points:raise ValueError("Mission report contains no observed odometry")
    w,h=grid["width"],grid["height"];cell=min(486/w,350/h)
    left,top=54+(486-w*cell)/2,184+(350-h*cell)/2
    pieces=['<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="700" viewBox="0 0 1100 700">',
      '<rect width="1100" height="700" fill="#101827"/>',
      '<style>text{font-family:Arial,sans-serif;fill:#e5eaf3}.muted{fill:#9cabc2}.title{font-size:27px;font-weight:700}.label{font-size:14px}.small{font-size:12px}.metric{font-size:25px;font-weight:700}</style>',
      '<text class="title" x="40" y="49">Goose | real ROS 2 migration mission</text>',
      '<text class="label muted" x="40" y="77">Gazebo physics + SLAM Toolbox + Nav2 | recorded telemetry, one simulated robot</text>',
      '<rect x="32" y="111" width="518" height="453" rx="12" fill="#1b2638"/>',
      '<rect x="568" y="111" width="500" height="453" rx="12" fill="#1b2638"/>',
      '<text x="54" y="141" font-size="18">Observed occupancy map</text>',
      '<text x="54" y="163" class="small muted">Map frame | free cells light, obstacles dark, unknown gray</text>',
      '<text x="590" y="141" font-size="18">Measured robot trajectory</text>',
      '<text x="590" y="163" class="small muted">Odometry frame | separate axes preserve frame accuracy</text>']
    pieces.append('<g shape-rendering="crispEdges">')
    for y in range(h):
        x=0
        while x<w:
            value=grid["data"][y*w+x];color="#64748b" if value<0 else "#162032" if value>=50 else "#d9e3ef"
            end=x+1
            while end<w:
                other=grid["data"][y*w+end]
                other_color="#64748b" if other<0 else "#162032" if other>=50 else "#d9e3ef"
                if other_color!=color:break
                end+=1
            pieces.append(f'<rect x="{left+x*cell:.2f}" y="{top+(h-y-1)*cell:.2f}" width="{(end-x)*cell+.02:.2f}" height="{cell+.02:.2f}" fill="{color}"/>');x=end
    pieces.append('</g>')
    goals=[]
    for state in report.get("agentStatus",[]):
        goal=state.get("selected_goal")
        if isinstance(goal,list) and len(goal)==2 and goal not in goals:goals.append(goal)
    for gx,gy in goals:
        px=left+(gx-grid["origin"][0])/grid["resolution"]*cell
        py=top+(h-(gy-grid["origin"][1])/grid["resolution"])*cell
        if left<=px<=left+w*cell and top<=py<=top+h*cell:
            pieces.append(f'<circle cx="{px:.2f}" cy="{py:.2f}" r="5" fill="#f5ae50" stroke="#101827" stroke-width="2"/>')
    goal_caption="Orange markers: recently selected goals" if goals else "No active goal at the end of the observation window"
    pieces.append(f'<text x="54" y="552" class="small muted">{goal_caption}</text>')
    xmin=min(p[0] for p in points);xmax=max(p[0] for p in points)
    ymin=min(p[1] for p in points);ymax=max(p[1] for p in points)
    extent=max(xmax-xmin,ymax-ymin,.5)*1.25;cx=(xmin+xmax)/2;cy=(ymin+ymax)/2
    project=lambda p:(818+(p[0]-cx)*326/extent,356-(p[1]-cy)*326/extent)
    for i in range(5):
        pos=193+i*81.5
        pieces.append(f'<line x1="655" y1="{pos}" x2="981" y2="{pos}" stroke="#33435a"/><line x1="{655+i*81.5}" y1="193" x2="{655+i*81.5}" y2="519" stroke="#33435a"/>')
    polyline=" ".join(f"{x:.2f},{y:.2f}" for x,y in map(project,points))
    pieces.append(f'<polyline points="{polyline}" fill="none" stroke="#60dfbf" stroke-width="3" stroke-linejoin="round"/>')
    for p,color,r in [(points[0],"#d9e3ef",6),(points[-1],"#60dfbf",7)]:
        x,y=project(p);pieces.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{r}" fill="{color}" stroke="#101827" stroke-width="2"/>')
    pieces.append(f'<text x="590" y="544" class="small muted">White: start | green: last observed position | grid: {extent/4:.2f} m</text>')
    confirmed=report.get("nav2GetResultStatuses",{})
    goal_label="NAV2 CONFIRMED GOALS" if confirmed and all(v==4 for v in confirmed.values()) and len(confirmed)==report.get("completedGoals") else "REPORTED GOALS"
    metrics=[("PHYSICS TRAVEL",f'{report.get("distanceMeters",0):.3f} m'),(goal_label,str(report.get("completedGoals",0))),
             ("RRT FRONTIERS",str(report.get("detectedFrontiers",0))),("ACCEPTANCE",f'{report.get("passed",0)}/{report.get("total",0)} {report.get("verdict","unknown").upper()}')]
    for i,(label,value) in enumerate(metrics):
        x=42+i*265;pieces.append(f'<text x="{x}" y="600" class="small muted">{label}</text><text x="{x}" y="633" class="metric">{html.escape(value)}</text>')
    pieces.append(f'<text x="40" y="674" class="small muted">{report.get("lidarMessages",0)} lidar messages | {report.get("mapMessages",0)} SLAM maps | {report.get("durationWallSeconds",0):.1f} s observed | no physical hardware validation</text></svg>')
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text("\n".join(pieces)+"\n")
    return {"path":str(output.resolve()),"sha256":hashlib.sha256(output.read_bytes()).hexdigest(),"sourceReport":str(report_path.resolve()),"sourceReportSha256":hashlib.sha256(report_path.read_bytes()).hexdigest(),"kind":"observed-telemetry-svg"}


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("report",type=Path);parser.add_argument("output",type=Path)
    args=parser.parse_args();print(json.dumps(render(args.report,args.output),indent=2))
