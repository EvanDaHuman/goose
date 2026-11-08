#!/usr/bin/env python3
"""Reproducible robotics adapter. All candidate code executes in a capped container."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
import select

ROOT=Path(__file__).resolve().parents[1]
ROBOTICS=ROOT/"robotics"
STATE=ROOT/"var/robotics/runtime"
IMAGE=os.environ.get("GOOSE_ROBOTICS_IMAGE","goose-robotics:jazzy")


def hashes(directory):
    return {str(p.relative_to(directory)):hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(directory.rglob("*")) if p.is_file() and "__pycache__" not in str(p)}


def run_container(command, mounts, timeout=600, log="container.log", memory="3g"):
    STATE.mkdir(parents=True,exist_ok=True)
    container="goose-robotics-"+uuid.uuid4().hex[:12]
    argv=["docker","run","--name",container,"--rm","--network","none","--cap-drop","ALL","--security-opt","no-new-privileges",
          "--pids-limit","512","--memory",memory,"--cpus","3","--env","ROS_LOCALHOST_ONLY=1","--env","PYTHONDONTWRITEBYTECODE=1"]
    for source,target,readonly in mounts:
        argv.extend(["--mount",f"type=bind,source={source},target={target}"+( ",readonly" if readonly else "")])
    argv.extend([IMAGE,"bash","-lc",command])
    began=time.monotonic()
    with (STATE/log).open("w") as output:
        try:
            p=subprocess.run(argv,stdout=output,stderr=subprocess.STDOUT,timeout=timeout)
            code=p.returncode
        except subprocess.TimeoutExpired:
            code=124
        finally:
            subprocess.run(["docker","rm","-f",container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
    return {"exitCode":code,"seconds":round(time.monotonic()-began,3),"log":str(STATE/log)}


def build(candidate):
    validate_candidate(candidate)
    workspace=STATE/"workspace"
    src=workspace/"src/goose_rrt_exploration"
    if src.exists():shutil.rmtree(src)
    src.parent.mkdir(parents=True,exist_ok=True)
    shutil.copytree(candidate,src,ignore=shutil.ignore_patterns("__pycache__","*.pyc"))
    result=run_container("set -e\nsource /opt/ros/jazzy/setup.bash\ncd /workspace\npython3 -m compileall -q src\ncolcon build --executor sequential --event-handlers console_direct+",[(workspace,"/workspace",False)],log="build.log")
    result.update({"stage":"build","candidateFiles":hashes(candidate),"image":IMAGE,"verdict":"pass" if result["exitCode"]==0 else "fail"})
    (STATE/"build.json").write_text(json.dumps(result,indent=2)+"\n")
    return result


def validate_candidate(candidate):
    if not candidate.is_dir():raise RuntimeError("Candidate package directory does not exist")
    if any(p.is_symlink() for p in candidate.rglob("*")):raise RuntimeError("Candidate symlinks are not allowed")
    if sum(p.stat().st_size for p in candidate.rglob("*") if p.is_file())>20*1024*1024:raise RuntimeError("Candidate exceeds 20 MiB source limit")


def baseline(candidate):
    """Accept the audited legacy fixture only, then execute its real algorithms."""
    validate_candidate(candidate);check_frozen_verifier()
    manifest=json.loads((ROBOTICS/"source/manifest.json").read_text())
    for rel,expected in manifest["files"].items():
        p=candidate/rel
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:
            raise RuntimeError(f"Unsupported or changed ROS1 source: {rel}; this robotics adapter currently validates the pinned rrt_exploration fixture")
    sys.path.insert(0,str(ROBOTICS/"runner"))
    from baseline import grid,load_legacy
    functions=load_legacy(candidate/"scripts/functions.py")
    m=grid(width=6,height=6,resolution=.5,origin=(0.,0.))
    checks=[{"name":"legacy cell index","passed":functions["index_of_point"](m,[1.,1.])==14},
            {"name":"legacy Python2 coordinate semantics","passed":functions["point_of_index"](m,14)==[1.,1.]},
            {"name":"legacy occupancy","passed":functions["gridValue"](m,[1.5,1.])==-1},
            {"name":"legacy information gain","passed":functions["informationGain"](m,[1.,1.],.5)==.25}]
    result={"stage":"baseline","verdict":"pass" if all(c["passed"] for c in checks) else "fail","checks":checks,"total":len(checks),"passed":sum(c["passed"] for c in checks),
            "sourceRevision":manifest["revision"],"sourceFiles":manifest["files"],"ros1RuntimeExecuted":False,"baseline":"pinned legacy source executed with explicit Python2 integer-division compatibility"}
    (STATE/"baseline.json").write_text(json.dumps(result,indent=2)+"\n")
    return result


def verify(candidate):
    check_frozen_verifier()
    validate_candidate(candidate)
    before=hashes(candidate)
    for p in [STATE/"core.json",STATE/"verification.json"]:p.unlink(missing_ok=True)
    sys.path.insert(0,str(ROBOTICS/"runner"));from verify_core import verify as verify_values
    began=time.monotonic()
    with CandidateProcess(candidate) as module:
        report=verify_values(ROBOTICS/"source/rrt_exploration/scripts/functions.py",candidate/"scripts/core.py",module)
    report=json.loads(json.dumps(report,allow_nan=True),parse_constant=lambda value:value)
    report.update({"execution":{"seconds":round(time.monotonic()-began,3),"isolation":"candidate-only container RPC; expected values and report writer remain in host verifier"},"candidateFiles":before,"integrityUnchanged":before==hashes(candidate),"verifierManifestSha256":hashlib.sha256((ROBOTICS/"verification-manifest.json").read_bytes()).hexdigest()})
    if not report["integrityUnchanged"]:report["verdict"]="fail"
    (STATE/"verification.json").write_text(json.dumps(report,indent=2)+"\n")
    return report


class CandidateProcess:
    def __init__(self,candidate):
        self.name="goose-core-"+uuid.uuid4().hex[:12]
        self.log=(STATE/"core-stderr.log").open("w")
        args=["docker","run","--name",self.name,"--rm","-i","--network","none","--read-only","--tmpfs","/tmp:rw,noexec,nosuid,size=32m","--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","32","--memory","256m","--cpus","1","--env","PYTHONDONTWRITEBYTECODE=1",
              "--mount",f"type=bind,source={candidate},target=/candidate,readonly","--mount",f"type=bind,source={ROBOTICS/'runner/candidate_rpc.py'},target=/rpc.py,readonly",IMAGE,"python3","-u","/rpc.py","/candidate/scripts/core.py"]
        self.process=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True,bufsize=1)
    def __getattr__(self,op):
        def call(*args,**kwargs):
            def plain(value):
                if hasattr(value,"__dict__"):return {"__object__":{k:plain(v) for k,v in vars(value).items()}}
                if isinstance(value,(list,tuple)):return [plain(v) for v in value]
                if isinstance(value,dict):return {k:plain(v) for k,v in value.items()}
                return value
            identity=uuid.uuid4().hex
            self.process.stdin.write(json.dumps({"id":identity,"op":op,"args":plain(args),"kwargs":plain(kwargs)})+"\n");self.process.stdin.flush()
            readable,_,_=select.select([self.process.stdout],[],[],10)
            if not readable:
                self.process.kill();self.process.wait()
                raise TimeoutError("Candidate did not return a result")
            line=self.process.stdout.readline(100000)
            if not line:raise RuntimeError("Candidate exited without a result")
            result=json.loads(line)
            if result.get("id")!=identity:raise RuntimeError("Candidate response did not match request")
            if "error" in result:raise RuntimeError(result["error"])
            value=result.get("value")
            if isinstance(value,dict) and set(value)=={"__number__"}:return float(value["__number__"])
            return value
        return call
    def __enter__(self):return self
    def __exit__(self,*args):
        if self.process.poll() is None:
            try:self.process.stdin.close()
            except BrokenPipeError:pass
            try:self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
        subprocess.run(["docker","rm","-f",self.name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        for stream in [self.process.stdin,self.process.stdout]:
            try:stream.close()
            except BrokenPipeError:pass
        self.log.close()


def check_frozen_verifier():
    manifest=json.loads((ROBOTICS/"verification-manifest.json").read_text())
    for rel,expected in manifest["files"].items():
        actual=hashlib.sha256((ROBOTICS/rel).read_bytes()).hexdigest()
        if actual!=expected:raise RuntimeError(f"Frozen verifier changed: {rel}")


def simulate(candidate, seconds=180):
    check_frozen_verifier()
    verifier=(ROBOTICS/"verification-manifest.json").read_bytes()
    if not (STATE/"workspace/install/setup.bash").exists():raise RuntimeError("Build the candidate before simulation")
    built=json.loads((STATE/"build.json").read_text())
    if built.get("candidateFiles")!=hashes(candidate):raise RuntimeError("Candidate changed after build; rebuild first")
    for p in [STATE/"simulation.json",STATE/"simulator-ready.json",STATE/"observed-map.json"]:p.unlink(missing_ok=True)
    nonce=uuid.uuid4().hex;name="goose-simulator-"+nonce[:12];worker_name="goose-candidate-"+nonce[:12];network="goose-mission-"+nonce[:12]
    # A private internal bridge supplies distinct DDS host identities with no
    # external route. Filesystems and IPC remain separate; DDS uses UDP only.
    subprocess.run(["docker","network","create","--internal",network],check=True,stdout=subprocess.DEVNULL,timeout=30)
    common=["--rm","--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","512","--env","ROS_LOCALHOST_ONLY=0","--env","FASTDDS_BUILTIN_TRANSPORTS=UDPv4","--env","PYTHONDONTWRITEBYTECODE=1"]
    simulation_args=["docker","run","--name",name,*common,"--network",network,"--memory","4g","--cpus","2",
      "--mount",f"type=bind,source={ROBOTICS},target=/verification,readonly","--mount",f"type=bind,source={STATE},target=/results",IMAGE,"bash","-lc",
      f"source /opt/ros/jazzy/setup.bash\npython3 /verification/runner/simulate.py --external-candidate --nonce {nonce} --seconds {int(seconds)} --out /results/simulation.json"]
    began=time.monotonic();worker=None;running=False;code=124
    with (STATE/"simulation.log").open("w") as log,(STATE/"candidate.log").open("w") as worker_log:
        simulation=subprocess.Popen(simulation_args,stdout=log,stderr=subprocess.STDOUT)
        try:
            deadline=time.monotonic()+seconds+90
            while simulation.poll() is None and time.monotonic()<deadline:
                if worker is None and (STATE/"simulator-ready.json").exists():
                    ready=json.loads((STATE/"simulator-ready.json").read_text())
                    if ready.get("nonce")!=nonce:raise RuntimeError("Simulator readiness nonce mismatch")
                    args=["docker","run","--name",worker_name,*common,"--network",network,"--memory","768m","--cpus","1","--read-only","--tmpfs","/tmp:rw,nosuid,size=128m","--env","HOME=/tmp",
                          "--mount",f"type=bind,source={STATE/'workspace'},target=/workspace,readonly",IMAGE,"bash","-lc",
                          "source /opt/ros/jazzy/setup.bash\nsource /workspace/install/setup.bash\nros2 launch goose_rrt_exploration exploration.launch.py use_sim_time:=True"]
                    worker=subprocess.Popen(args,stdout=worker_log,stderr=subprocess.STDOUT)
                time.sleep(.5)
            code=simulation.poll() if simulation.poll() is not None else 124
            running=worker is not None and worker.poll() is None
        finally:
            for container in [worker_name,name]:subprocess.run(["docker","rm","-f",container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            for proc in [worker,simulation]:
                if proc is not None and proc.poll() is None:
                    try:proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:proc.kill();proc.wait()
            subprocess.run(["docker","network","rm",network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
    result={"exitCode":code,"seconds":round(time.monotonic()-began,3),"log":str(STATE/"simulation.log"),"isolation":"simulation/observer and candidate run in separate filesystem containers"}
    report=json.loads((STATE/"simulation.json").read_text()) if (STATE/"simulation.json").exists() else {"verdict":"fail","error":"Simulation produced no report"}
    expected_names=["Gazebo simulation clock advanced","real lidar scans received","SLAM occupancy maps received","map to robot transform available","Nav2 action server ready","robot moved at least 0.25 m in physics","migrated RRT published frontiers","migrated assignment completed a Nav2 goal","migrated package remained running"]
    checks=report.get("checks",[])
    if [c.get("name") for c in checks]!=expected_names[:-1]:
        report["observedChecks"]=checks
        checks=[{"name":name,"passed":False,"reason":"Observer did not produce the complete expected check set"} for name in expected_names[:-1]]
    checks.append({"name":"migrated package remained running","passed":running})
    report.update({"checks":checks,"total":len(checks),"passed":sum(c.get("passed") is True for c in checks)})
    report.update({"execution":result,"candidateFiles":built["candidateFiles"],"verifierManifestSha256":hashlib.sha256(verifier).hexdigest(),"verifierVersion":json.loads(verifier)["version"]})
    captured_map=STATE/"observed-map.json"
    if captured_map.exists():
        report["mapArtifact"]={"path":str(captured_map),"sha256":hashlib.sha256(captured_map.read_bytes()).hexdigest(),"frame":"map"}
    report["trajectoryFrame"]="odom"
    unchanged=verifier==(ROBOTICS/"verification-manifest.json").read_bytes() and all(
        (ROBOTICS/rel).is_file() and hashlib.sha256((ROBOTICS/rel).read_bytes()).hexdigest()==expected
        for rel,expected in json.loads(verifier)["files"].items())
    report["verifierUnchangedDuringRun"]=unchanged
    if result["exitCode"]!=0 or not unchanged or report.get("nonce")!=nonce or [c.get("name") for c in checks]!=expected_names or not all(c.get("passed") is True for c in checks):report["verdict"]="fail"
    (STATE/"simulation.json").write_text(json.dumps(report,indent=2)+"\n")
    return report


def evidence(candidate):
    result={"source":json.loads((ROBOTICS/"source/manifest.json").read_text()),"generatedBy":"Naive live agent","realCustomer":False,
            "ros1Baseline":"source algorithm replay with Python2 compatibility, not a ROS1 simulator","robotHardwareValidated":False}
    for stage,filename in [("generation","naive-generation.json"),("build","build.json"),("verification","verification.json"),("simulation","simulation.json")]:
        p=(ROBOTICS/"evidence"/filename) if stage=="generation" else STATE/filename
        result[stage]=json.loads(p.read_text()) if p.exists() else {"verdict":"not_run"}
    result["repairs"]=[json.loads(p.read_text()) for p in sorted((ROBOTICS/"evidence").glob("naive-repair-*.json"))]
    environment=ROBOTICS/"evidence/environment.json"
    if environment.exists():result["environment"]=json.loads(environment.read_text())
    result["recordedImplementationMicroUsd"]=result["generation"].get("consumedMicroUsd",0)+sum(r.get("consumedMicroUsd",0) for r in result["repairs"])
    current=hashes(candidate)
    result["sameCandidateVerified"]=all(result[s].get("candidateFiles")==current for s in ["build","verification","simulation"])
    result["verdict"]="pass" if result["sameCandidateVerified"] and all(result[s].get("verdict")=="pass" for s in ["build","verification","simulation"]) else "incomplete"
    (ROBOTICS/"evidence/latest.json").write_text(json.dumps(result,indent=2)+"\n")
    return result


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage",choices=["baseline","build","verify","simulate","evidence"])
    parser.add_argument("--candidate",type=Path,default=ROBOTICS/"generated")
    parser.add_argument("--seconds",type=int,default=180)
    args=parser.parse_args()
    if args.seconds<30 or args.seconds>600:parser.error("Simulation duration must be 30 to 600 seconds")
    candidate=args.candidate.resolve()
    if candidate!=(ROBOTICS/"generated").resolve():
        STATE=ROOT/"var/robotics/jobs"/hashlib.sha256(str(candidate).encode()).hexdigest()[:20]
    STATE.mkdir(parents=True,exist_ok=True)
    try:
        result={"baseline":lambda:baseline(candidate),"build":lambda:build(candidate),"verify":lambda:verify(candidate),"simulate":lambda:simulate(candidate,args.seconds),"evidence":lambda:evidence(candidate)}[args.stage]()
        summary={"verdict":result["verdict"],"sameCandidateVerified":result["sameCandidateVerified"],"recordedImplementationMicroUsd":result["recordedImplementationMicroUsd"],"path":str(ROBOTICS/"evidence/latest.json")} if args.stage=="evidence" else {k:v for k,v in result.items() if k not in ["checks","candidateFiles","sourceFiles","source","generation","trajectory","mapHistory","agentStatus"]}
        print(json.dumps(summary,indent=2))
        sys.exit(0 if result.get("verdict")=="pass" else 1)
    except Exception as exc:
        print(json.dumps({"stage":args.stage,"verdict":"fail","error":str(exc)}));sys.exit(1)
