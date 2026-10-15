"""Small Python function subset, with allocation/step guards; not an OS sandbox.

Seatbelt remains mandatory. No imports, attributes, dynamic calls, exception
handlers, decorators, generators or filesystem APIs are accepted from source.
"""
import ast

BUILTINS = {"len", "sum", "min", "max", "abs", "round", "range", "sorted"}
OPS = {ast.Add: "add", ast.Sub: "sub", ast.Mult: "mul", ast.Div: "div", ast.FloorDiv: "floordiv", ast.Mod: "mod"}
ALLOWED = (ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return, ast.Assign, ast.AugAssign,
           ast.For, ast.If, ast.Break, ast.Continue, ast.Expr, ast.Pass, ast.Name, ast.Load, ast.Store,
           ast.Constant, ast.List, ast.Tuple, ast.Dict, ast.Subscript, ast.Slice, ast.Call, ast.keyword,
           ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp,
           ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.UAdd, ast.USub, ast.Not,
           ast.And, ast.Or, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.Is, ast.IsNot)


def validate(tree):
    nodes = list(ast.walk(tree))
    functions = tree.body
    if (len(nodes) > 1000 or not functions or len(functions) > 10
            or any(not isinstance(n, ast.FunctionDef) for n in functions)):
        raise ValueError()
    names = {f.name for f in functions}
    if len(names) != len(functions) or names & BUILTINS:
        raise ValueError()
    for n in nodes:
        if not isinstance(n, ALLOWED):
            raise ValueError()
        if isinstance(n, ast.FunctionDef):
            a = n.args
            if (n not in functions or n.name.startswith("_") or n.decorator_list or n.returns
                    or a.defaults or a.kw_defaults or a.kwonlyargs or a.vararg or a.kwarg
                    or len(a.args) + len(a.posonlyargs) > 10):
                raise ValueError()
        if isinstance(n, ast.arg) and (n.annotation or n.arg.startswith("__")):
            raise ValueError()
        if isinstance(n, ast.Name) and n.id.startswith("__"):
            raise ValueError()
        if isinstance(n, ast.Call) and (not isinstance(n.func, ast.Name) or n.func.id not in names | BUILTINS
                                       or any(k.arg is None for k in n.keywords)):
            raise ValueError()
        if isinstance(n, ast.Assign) and any(not isinstance(t, ast.Name) for t in n.targets):
            raise ValueError()
        if isinstance(n, (ast.AugAssign, ast.For)) and not isinstance(n.target, ast.Name):
            raise ValueError()
        if isinstance(n, ast.Dict) and any(k is None for k in n.keys):
            raise ValueError()
        if isinstance(n, ast.Constant):
            v = n.value
            if not (v is None or type(v) is bool or type(v) in (int, float) and abs(v) <= 10**15
                    or type(v) is str and len(v) <= 10000):
                raise ValueError()


class Guards(ast.NodeTransformer):
    def visit_BinOp(self, node):
        self.generic_visit(node)
        return ast.copy_location(ast.Call(ast.Name("__synplex_binary", ast.Load()),
            [ast.Constant(OPS[type(node.op)]), node.left, node.right], []), node)

    def visit_Assign(self, node):
        self.generic_visit(node)
        node.value = ast.Call(ast.Name("__synplex_value", ast.Load()), [node.value], [])
        return node

    def visit_AugAssign(self, node):
        return self.visit(ast.copy_location(ast.Assign([node.target], ast.BinOp(
            ast.copy_location(ast.Name(node.target.id, ast.Load()), node.target), node.op, node.value)), node))

    def visit_Return(self, node):
        self.generic_visit(node)
        node.value = ast.Call(ast.Name("__synplex_value", ast.Load()), [node.value or ast.Constant(None)], [])
        return node


def prepare_source(source):
    try:
        tree = ast.parse(source)
        validate(tree)
        return ast.unparse(ast.fix_missing_locations(Guards().visit(tree)))
    except (ValueError, SyntaxError, RecursionError, TypeError, OverflowError):
        raise ValueError("本次只测试小型Python函数：可用基本运算、条件、循环及常用统计函数；暂不运行导入、文件操作、类或完整项目。原文件仍保留。") from None


# Inserted into the trusted child runner, never supplied by a model or upload.
RUNTIME = r'''
import math,operator
def safe_value(value):
    stack=[(value,0)];count=0;size=0
    while stack:
        v,depth=stack.pop();count+=1
        if count>4000 or depth>20: raise ValueError('value limit')
        kind=type(v)
        if v is None or kind is bool: continue
        if kind in (int,float):
            if abs(v)>10**15 or kind is float and not math.isfinite(v): raise ValueError('number limit')
        elif kind is str:
            if len(v)>10000: raise ValueError('text limit')
            size+=len(v)
            if size>32000: raise ValueError('combined text limit')
        elif kind in (list,tuple):
            if len(v)>1000: raise ValueError('list limit')
            stack.extend((x,depth+1) for x in v)
        elif kind is dict:
            if len(v)>1000 or any(type(k) is not str or len(k)>1000 for k in v): raise ValueError('map limit')
            size+=sum(len(k) for k in v)
            if size>32000: raise ValueError('combined text limit')
            stack.extend((x,depth+1) for x in v.values())
        else: raise ValueError('unsupported value')
    return value
def bounded_range(*args):
    if any(type(x) is not int or abs(x)>10**6 for x in args): raise ValueError('range limit')
    value=range(*args)
    if len(value)>1000: raise ValueError('range limit')
    return value
def safe_binary(kind,left,right):
    safe_value(left);safe_value(right)
    if kind=='mul':
        sequence,number=(left,right) if type(left) in (str,list,tuple) else (right,left)
        if type(sequence) in (str,list,tuple):
            if type(number) is not int or len(sequence)*max(0,number)>(10000 if type(sequence) is str else 1000):
                raise ValueError('allocation limit')
    if kind=='mod' and (type(left) not in (int,float) or type(right) not in (int,float)):
        raise ValueError('numeric remainder only')
    operations={'add':operator.add,'sub':operator.sub,'mul':operator.mul,'div':operator.truediv,'floordiv':operator.floordiv,'mod':operator.mod}
    return safe_value(operations[kind](left,right))
SAFE_BUILTINS={'len':len,'sum':sum,'min':min,'max':max,'abs':abs,'round':round,'range':bounded_range,'sorted':sorted}
'''
