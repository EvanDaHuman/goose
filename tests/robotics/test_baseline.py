"""Checks the source baseline compatibility layer, including Python 2 division."""
import math
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "robotics/runner"))
from baseline import grid, load_legacy, py2_div


def test_python2_integer_division_semantics():
    assert py2_div(7,3)==2
    assert py2_div(-1,3)==-1
    assert py2_div(7.,3)==7/3


def test_legacy_functions_are_executable_without_ros():
    f=load_legacy(ROOT/"robotics/source/rrt_exploration/scripts/functions.py")
    m=grid(width=6,height=6,resolution=.5,origin=(0.,0.))
    assert f["index_of_point"](m,[1.,1.])==14
    assert f["point_of_index"](m,14)==[1.,1.]
    assert f["gridValue"](m,[1.,1.])==0
    assert f["gridValue"](m,[1.5,1.])==-1
    assert f["informationGain"](m,[1.,1.],.5)==.25
    path=[SimpleNamespace(pose=SimpleNamespace(position=SimpleNamespace(x=float(x),y=0.))) for x in range(5)]
    assert f["pathCost"](path)==4
    assert math.isinf(f["pathCost"]([]))
