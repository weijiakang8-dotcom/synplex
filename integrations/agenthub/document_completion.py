"""Return a single document tool's real delivery without a model wrap-up.

The normal verifier still decides whether the manuscript meets the request.
Only the evaluated upstream bridge is adapted; no success is fabricated from
a filename, a model assertion, an error, or a foreign artifact.
"""
import hashlib
import inspect
import re
import textwrap
import uuid

EVALUATED = '2a07337ddc2d53a7802ff1653ee7f2afe721def6df0f81b5ad5173576d8740f0'


def create_step_agent(step, execution=None, **kwargs):
    """Documents use the registered tools, not an empty virtual filesystem.

    General work keeps the existing Deep Agents harness. A document worker
    already receives its evidence inline and reads authorized old files via
    read_task_file; exposing a second, empty filesystem invites false reads.
    The Gateway model, shared ledger, tool bridge and verifier are unchanged.
    """
    if step.get('capability') != 'document':
        from deepagents import create_deep_agent
        return create_deep_agent(**kwargs)
    from langchain.agents import create_agent
    kwargs.pop('subagents', None)
    limit = document_limit(execution or {}, step)
    if limit:
        kwargs['system_prompt'] += (f'\n本次文稿上限为{limit}个中文字，标题、小节、引用和附注也计入。'
            f'请先分配各节篇幅，初稿以不超过{limit * 3 // 4}个中文字为写作目标，给必要来源和补充留余量；'
            '这是篇幅建议，不改变用户上限或交付要求。使用短句，合并重复解释，不能删掉必需事实、负结果或来源。'
            '模型自报字数不是测量结果，实际导出参数仍由程序核对。')
    kwargs['system_prompt'] += ('\n先逐项核对用户原始要求和真实补答，为每个必答问题安排具体正文，不用职责概述替代事件的改变过程。'
        '逐一回答用户的“谁、为什么、如何、哪些”；要求说明做法时，写清动作、保存对象与核对办法，不能只写“保留、可查”。'
        '导出前对照每个明确问题检查正文；篇幅不足先压缩重复背景，不删除必答项。历史或尚未确认的内容须在相应小节限定时间与状态，不能把旧记录的“仍未完成”当作今天的状态。'
        '涉及谁改变了方案时，要写原方案、提出者的具体纠正、调整后的做法；若原文没有过程，明确缺口，不能用职责列表代替。'
        '面对非技术读者时，按用户能做什么、输入什么、得到什么来解释；不把程序架构词直接当功能说明。'
        '按用户要求的粒度列出处，未明确粒度时可在相关小节统一列“来源：《真实标题》”。标题只能取本次完整背景中sourceReferences的标题、真实路径文件名或本次实际成功读取的原文件名；'
        '聊天回答提到的标题、原文中的双链不是自动可用的来源。没有对应原文就说明缺依据，不引用它。'
        '未人工确认的原始记录只能表述为“原记录记载”及当时范围，不称已核验、授权来源或当前确定事实。'
        '用户要求原样保留旧稿时，逐字保留未要求改动的正文和引用，仅追加明确要求的内容。')
    return create_agent(**kwargs)


async def scoped_file_tools(state, tools):
    """Do not advertise file-only tools when this execution has no files.

    Evidence excerpts and historical hashes are not uploaded task files. The
    existing ToolExecutor still enforces each read; this only narrows the menu.
    """
    from app.database import async_session_factory
    from app.models import Execution
    from sqlalchemy import text
    async with async_session_factory() as session:
        execution = await session.get(Execution, uuid.UUID(state['execution_id']))
        if (not execution or str(execution.user_id) != str(state.get('user_id'))
                or str(execution.organization_id) != str(state.get('organization_id'))):
            raise PermissionError('Task file menu identity mismatch')
        present = (await session.execute(text('SELECT 1 FROM synplex_task_files WHERE execution_id=:execution LIMIT 1'),
                                        {'execution': state['execution_id']})).scalar()
    file_only = {'read_task_file', 'summarize_table', 'check_task_code', 'test_task_python'}
    return tools if present else [tool for tool in tools if tool.name not in file_only]


def document_limit(execution, step):
    """Only an unambiguous current whole-document bound is enforceable."""
    if (step.get('capability') != 'document'
            or sum(s.get('capability') == 'document' for s in execution.get('plan') or []) != 1):
        return None
    from clarification_gate import answered_view
    request = str(answered_view(execution).get('user_input') or '').split(
        '\n\n完整背景与原文依据（只作证据', 1)[0]
    limits = set(re.findall(r'(?:合计|总共|全文|正文)?不超过\s*([1-9][0-9]{0,5})\s*中文字', request))
    if len(limits) != 1 or re.search(r'不计入|原三部分|每部分[^。；\n]{0,20}(?:字|上限)|分别不超过', request):
        return None
    return int(next(iter(limits)))


def document_middleware(execution, step):
    """Reject an oversized draft before any export, with one bounded repair.

    Read only the explicit current request, never numeric instructions hidden
    in imported evidence. Ambiguous or section-specific limits stay with the
    normal semantic verifier. No text is truncated or silently rewritten.
    """
    limit = document_limit(execution, step)
    if not limit:
        return []
    from langchain.agents.middleware import AgentMiddleware, hook_config
    from langchain_core.messages import AIMessage, ToolMessage

    class DocumentLength(AgentMiddleware):
        name = 'SynplexDocumentLength'
        rejected = 0

        @hook_config(can_jump_to=['model'])
        async def aafter_model(self, state, runtime):
            message = state['messages'][-1]
            if not isinstance(message, AIMessage):
                return None
            failures = []
            for call in message.tool_calls:
                content = call.get('args', {}).get('content')
                if call['name'] == 'export_document' and isinstance(content, str):
                    count = len(re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff]', content))
                    if count > limit:
                        failures.append({'han_characters': count, 'limit': limit,
                            'draft_sha256': hashlib.sha256(content.encode()).hexdigest()})
            if not failures:
                return None
            self.rejected += 1
            from app.engine.graph import audit_execution_event
            await audit_execution_event(execution_id=execution['execution_id'],
                organization_id=execution.get('organization_id'), user_id=execution.get('user_id'),
                action='document_preflight_rejected', details={'attempt': self.rejected, 'checks': failures})
            if self.rejected > 1:
                raise ValueError('文稿两次超过明确字数上限，未导出文件；请精简要求或修改文稿。')
            reason = ('尚未执行本轮任何工具。实际导出参数正文有' + str(failures[0]['han_characters'])
                + '个中文字，超过本次明确上限' + str(limit)
                + '，至少需删减' + str(failures[0]['han_characters'] - limit)
                + '个中文字。下稿请以不超过' + str(limit * 3 // 4)
                + '个中文字为精简目标，标题、小节、引用和附注均计入；合并重复解释，保留要求、来源与负结果。'
                '精简后重新调用，不要截断或声称已导出。只允许本次修正，仍受原任务预算限制。')
            return {'messages': [ToolMessage(content=reason, tool_call_id=call['id'],
                    name=call['name'], status='error') for call in message.tool_calls], 'jump_to': 'model'}

    return [DocumentLength()]


def requested_formats(step):
    """Recover omitted metadata only from this step's explicit format names.

    Do not infer from project history or artifact availability. Ambiguous or
    multiple formats retain the normal worker, so the first export cannot
    prematurely complete a multi-format request.
    """
    if step.get('artifact_formats'):
        return step['artifact_formats']
    # References and input filenames are not output requests. A source such
    # as 《原始记录.md》 must not turn one Word delivery into two formats.
    description = re.sub(r'《[^》]*》|`[^`]*`', '', str(step.get('description') or ''))
    clauses = re.split(r'[，,。；;\n]', description)
    outputs = []
    for clause in clauses:
        action = re.search(r'导出|输出|生成|制作|保存|交付|\b(?:export|output|generate|save|deliver)\b', clause, re.I)
        if action:
            outputs.append(clause[action.end():])
    text = ' '.join(outputs) + ' ' + str(step.get('output_name') or '')
    patterns = {'docx': r'(?<![a-z])(?:word|docx)(?![a-z])',
                'pdf': r'(?<![a-z])pdf(?![a-z])',
                'md': r'(?<![a-z])markdown(?![a-z])|\.md(?![a-z])'}
    return [fmt for fmt, pattern in patterns.items() if re.search(pattern, text, re.I)]


async def completed_output(state, step, artifacts, blockers, tool_results, fallback):
    formats = requested_formats(step)
    if (step.get('capability') != 'document' or len(formats) != 1 or blockers
            or not tool_results or any(r.get('status') not in {'success', 'duplicate'} for r in tool_results)):
        return fallback
    deliveries = [a for a in artifacts if a.get('format') == formats[0]]
    if len(deliveries) != 1 or not deliveries[0].get('verified'):
        return fallback
    from app.engine import document_step as module
    import asyncio
    texts = []
    for artifact in artifacts:
        async with module.async_session_factory() as session:
            row = await session.get(module.Artifact, uuid.UUID(artifact['id']))
            if (not row or str(row.execution_id) != str(state.get('execution_id'))
                    or str(row.user_id) != str(state.get('user_id'))
                    or str(row.organization_id) != str(state.get('organization_id'))
                    or not await asyncio.to_thread(module.verify_artifact, row)):
                raise PermissionError('Document completion identity or integrity mismatch')
            if artifact.get('format') == 'md':
                path = module.artifact_path(row)
                if path.stat().st_size > 2 * 1024 * 1024:
                    raise ValueError('Document manuscript exceeds bounded capacity')
                texts.append(await asyncio.to_thread(path.read_text, encoding='utf-8'))
    if len(texts) != 1 or len(texts[0].strip()) < 80:
        return fallback
    # File receipts and human review have their own structured fields. Keep
    # the manuscript literal; do not append an implementation status to it.
    return texts[0]


def install():
    from app.adapters import general_executor as module
    original = module.run_general_step
    if getattr(original, 'synplex_document_completion', False):
        return
    source = textwrap.dedent(inspect.getsource(original))
    if hashlib.sha256(source.encode()).hexdigest() != EVALUATED:
        raise RuntimeError('Document worker changed; reviewed completion adapter required')
    before = '            args_schema=spec.parameters,\n'
    after = before + ('            return_direct=(step.get("capability") == "document"\n'
                      '                           and spec.name == "export_document"\n'
                      '                           and len(synplex_requested_formats(step)) == 1),\n')
    marker = '    if any(r.get("status") not in {"success", "duplicate"} for r in tool_results):\n'
    agent_marker = '        subagents=subagents,\n'
    file_marker = '    await model.prepare_context_profile(tools=bool(bridged))\n'
    factory_marker = '    agent = create_deep_agent(\n'
    if any(source.count(anchor) != 1 for anchor in [before, marker, agent_marker, file_marker, factory_marker]):
        raise RuntimeError('Document completion patch anchors changed')
    source = source.replace(before, after).replace(marker,
        '    output = await synplex_completed_output(state, step, artifacts, blockers, tool_results, output)\n' + marker)
    source = source.replace(agent_marker, agent_marker + '        middleware=synplex_document_middleware(state, step),\n')
    source = source.replace(file_marker, '    bridged = await synplex_scoped_file_tools(state, bridged)\n' + file_marker)
    source = source.replace(factory_marker, '    agent = synplex_create_step_agent(step, execution=state,\n')
    namespace = {**vars(module), 'synplex_completed_output': completed_output,
                 'synplex_requested_formats': requested_formats,
                 'synplex_document_middleware': document_middleware,
                 'synplex_scoped_file_tools': scoped_file_tools,
                 'synplex_create_step_agent': create_step_agent}
    exec(compile(source, __file__ + ':evaluated-document-completion', 'exec'), namespace)
    adapted = namespace['run_general_step']
    adapted.synplex_document_completion = True
    module.run_general_step = adapted
    from app.engine import graph
    if getattr(graph, 'run_general_step', None) is original:
        graph.run_general_step = adapted
