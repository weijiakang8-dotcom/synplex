"""Honor the selected output allowance in the protected worker's budget math.

The pinned upstream worker hardcodes 4096 in both its reservation and model
clone. Adapt those four constants together, leaving call limits, cancellation,
cost checks, tools and durable usage untouched. Refuse unknown upstream code.
"""
import hashlib
import inspect
import textwrap

EVALUATED = "3c47e470cfc5d491df56decaa7168c0513879190be709154d82b62c4a3acdfc2"


def install():
    from step_inputs import install as install_step_inputs
    install_step_inputs()
    from document_delivery import install as install_document_delivery
    install_document_delivery()
    from app.adapters import gateway_chat_model as module
    cls = module.GatewayChatModel
    if getattr(cls._agenerate, "synplex_output_allowance", False):
        return
    source = textwrap.dedent(inspect.getsource(cls._agenerate))
    if hashlib.sha256(source.encode()).hexdigest() != EVALUATED or source.count("4096") != 4:
        raise RuntimeError("执行器回复预算实现已有变化，需先核对适配版本；没有启动任务。")
    namespace = dict(vars(module))
    code = source.replace("4096", 'int(self.profile.get("max_output_tokens", 4096))')
    exec(compile(code, __file__ + ":evaluated-worker-budget", "exec"), namespace)
    adapted = namespace["_agenerate"]
    adapted.synplex_output_allowance = True

    async def prepare(self, *, tools):
        candidates = await self.gateway.select(
            organization_id=self.organization_id, user_id=self.user_id,
            complexity=self.complexity,
            requirements=module.ModelRequirements(
                tools=tools, vision="vision" in self.required_capabilities,
                structured_output="structured_output" in self.required_capabilities,
                task_type=self.task_type,
            ),
        )
        capacities = [module.model_capacity(candidate) for candidate in candidates]
        if not capacities:
            raise RuntimeError("当前没有满足这项任务要求的模型。")
        output = min(capacity[1] for capacity in capacities)
        if type(output) is not int or not 1 <= output <= 131072:
            raise RuntimeError("所选型号的回复长度不在已验证范围内。")
        self.profile = {"max_input_tokens": min(max(1, int(window * 0.9) - output)
                                               for window, _, _ in capacities),
                        "max_output_tokens": output}

    cls.prepare_context_profile = prepare
    cls._agenerate = adapted
