"""Execute selected unmodified legacy functions with Python 2 integer division.

This is a source-level baseline, not a ROS 1/Gazebo run. ROS imports and robot
transport are deliberately excluded. The AST compatibility transform and small
vector implementation only supply the original Python/numpy execution semantics.
"""
import ast
import hashlib
import math
from pathlib import Path
from types import SimpleNamespace

FUNCTIONS = {"index_of_point", "point_of_index", "informationGain", "discount", "pathCost", "gridValue"}


class Vector(list):
    def __sub__(self, other):
        return Vector(a-b for a, b in zip(self, other))


def py2_div(a, b):
    return a // b if isinstance(a, int) and isinstance(b, int) else a / b


class Division(ast.NodeTransformer):
    def visit_BinOp(self, node):
        self.generic_visit(node)
        if isinstance(node.op, ast.Div):
            return ast.copy_location(ast.Call(func=ast.Name(id="_py2_div", ctx=ast.Load()), args=[node.left, node.right], keywords=[]), node)
        return node


def load_legacy(source):
    text = Path(source).read_text()
    module = ast.parse(text)
    module.body = [n for n in module.body if isinstance(n, ast.FunctionDef) and n.name in FUNCTIONS]
    module = ast.fix_missing_locations(Division().visit(module))
    env = {"array": Vector, "floor": math.floor, "norm": lambda a: math.sqrt(sum(x*x for x in a)), "inf": math.inf, "_py2_div": py2_div}
    exec(compile(module, str(source), "exec"), env)
    return {name: env[name] for name in FUNCTIONS}


def grid(width=12, height=12, resolution=0.5, origin=(-1.0, -1.0), data=None):
    if data is None:
        data = [100 if x in (0, width-1) or y in (0, height-1) else (-1 if x >= width//2 else 0)
                for y in range(height) for x in range(width)]
    return SimpleNamespace(info=SimpleNamespace(width=width, height=height, resolution=resolution,
        origin=SimpleNamespace(position=SimpleNamespace(x=origin[0], y=origin[1]))), data=list(data))


def source_hash(source):
    return hashlib.sha256(Path(source).read_bytes()).hexdigest()
