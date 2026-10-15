from __future__ import annotations

import asyncio
import uuid

from app.adapters.composition import build_effect_port
from app.adapters.errors import UnsupportedKernelWorkflowError
from app.adapters.kernel_execution_adapter import (
    build_runtime_input,
    is_kernel_workflow,
)
from app.adapters.kernel_runtime_bridge import persist_kernel_output
from app.config import settings
from app.database import async_session_factory
from app.kernel.runtime.loop import KernelRuntime
from app.models import Execution, Workflow
from app.models.enums import ExecutionStatus


async def run_kernel_execution(
    execution_id: uuid.UUID,
    effect_port=None,
):
    """KernelRuntime production runner。

    只处理显式 kernel_plan；不 fallback 到 legacy。
    """
    async with async_session_factory() as session:
        execution = await session.get(Execution, execution_id)
        if execution is None:
            return None
        workflow = await session.get(Workflow, execution.workflow_id)
        if workflow is None:
            raise UnsupportedKernelWorkflowError("workflow not found")
        if workflow.organization_id != execution.organization_id:
            raise UnsupportedKernelWorkflowError("execution/workflow tenant mismatch")

        if execution.status in {
            ExecutionStatus.RUNNING,
            ExecutionStatus.WAITING_FOR_APPROVAL,
            ExecutionStatus.COMPLETED,
            ExecutionStatus.ROLLED_BACK,
        }:
            return None

        if not is_kernel_workflow(workflow):
            raise UnsupportedKernelWorkflowError(
                "workflow has no kernel_plan; NOT_SUPPORTED_IN_KERNEL_MODE"
            )

        execution.status = ExecutionStatus.RUNNING
        execution.error_message = None
        await session.commit()

    if effect_port is None:
        effect_port = build_effect_port(settings)

    runtime_input = build_runtime_input(execution, workflow, effect_port)
    # KernelRuntime 是同步执行器，但 RealEffectExecutor.execute_effect 内部使用
    # asyncio.run。放在独立线程中运行，避免与 Celery task 的外层 asyncio.run 冲突。
    output = await asyncio.to_thread(KernelRuntime().run, runtime_input)
    await persist_kernel_output(execution_id, output)
    return output


__all__ = ["run_kernel_execution"]
