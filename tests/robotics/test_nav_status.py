import importlib.util
from pathlib import Path
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location("nav_status",Path(__file__).resolve().parents[2]/"robotics/runner/nav_status.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def status(value,identifier):
    return SimpleNamespace(status=value,goal_info=SimpleNamespace(goal_id=SimpleNamespace(uuid=identifier)))


def test_completion_ignores_untrusted_publishers_and_incomplete_goals():
    values=[status(4,[1]*16),status(2,[2]*16),status(6,[3]*16)]
    assert module.successful_goal_ids(values,False)==set()
    assert module.successful_goal_ids(values,True)=={"01"*16}


def test_completion_deduplicates_goal_uuid_and_rejects_empty_identifiers():
    values=[status(4,[1]*16),status(4,[1]*16),status(4,[2]*16),status(4,[0]*16),status(4,[])]
    assert module.successful_goal_ids(values,True)=={"01"*16,"02"*16}


def test_publisher_gid_matches_actual_navigator_endpoint():
    endpoints=[SimpleNamespace(node_name="bt_navigator",node_namespace="/",endpoint_gid=[1]*24),
               SimpleNamespace(node_name="candidate",node_namespace="/",endpoint_gid=[2]*24)]
    assert module.navigator_publisher({"publisher_gid":bytes([1]*24)},endpoints)=="/bt_navigator"
    assert module.navigator_publisher(SimpleNamespace(publisher_gid=[1]*24),endpoints)=="/bt_navigator"
    assert module.navigator_publisher({"publisher_gid":[2]*24},endpoints) is None
    assert module.navigator_publisher({"publisher_gid":[3]*24},endpoints) is None
    assert module.navigator_publisher({},endpoints) is None
    assert module.navigator_publisher({},endpoints[:1])=="/bt_navigator"
    assert module.navigator_publisher({},endpoints[1:]) is None
    assert module.navigator_publisher({"publisher_gid":[]},endpoints[:1]) is None
