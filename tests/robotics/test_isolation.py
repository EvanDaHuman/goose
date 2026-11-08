"""A candidate cannot forge the host-owned verification verdict."""
import importlib.util
import os
from pathlib import Path
import sys
import pytest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("robotics_adapter",ROOT/"robotics/run.py")
adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
sys.path.insert(0,str(ROOT/"robotics/runner"))
from verify_core import verify


@pytest.mark.skipif(os.environ.get("GOOSE_TEST_DOCKER")!="1",reason="Explicit Docker integration check")
def test_candidate_cannot_manufacture_success(tmp_path):
    import uuid,shutil
    candidate=ROOT/"var/robotics"/("malicious-test-"+uuid.uuid4().hex);scripts=candidate/"scripts";scripts.mkdir(parents=True)
    (scripts/"core.py").write_text('''import json
import sys
from pathlib import Path
sys.stderr.write('malicious candidate executed\\n')
try:
    Path('/results').mkdir(exist_ok=True)
    Path('/results/core.json').write_text(json.dumps({'verdict':'pass','total':111,'passed':111}))
except OSError:
    pass
print(json.dumps({'verdict':'pass','total':111,'passed':111}),flush=True)
raise SystemExit(0)
''')
    adapter.STATE=tmp_path/"results";adapter.STATE.mkdir()
    try:
        with adapter.CandidateProcess(candidate) as remote:
            result=verify(ROOT/"robotics/source/rrt_exploration/scripts/functions.py",scripts/"core.py",remote)
    finally:shutil.rmtree(candidate)
    assert result["verdict"]=="fail"
    assert result["failed"]>100
    assert not (adapter.STATE/"core.json").exists()
    assert "malicious candidate executed" in (adapter.STATE/"core-stderr.log").read_text()


def test_untrusted_source_change_is_rejected(tmp_path):
    import shutil
    source=tmp_path/"source"
    shutil.copytree(ROOT/"robotics/source/rrt_exploration",source)
    (source/"scripts/functions.py").write_text("raise SystemExit('do not execute')")
    adapter.STATE=tmp_path/"results";adapter.STATE.mkdir()
    # This test targets source identity, independent of verifier version updates.
    original=adapter.check_frozen_verifier
    adapter.check_frozen_verifier=lambda:None
    try:
        with pytest.raises(RuntimeError,match="Unsupported or changed ROS1 source"):
            adapter.baseline(source)
    finally:adapter.check_frozen_verifier=original
