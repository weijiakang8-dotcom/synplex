"""Keep the canonical manuscript visible to verification, never export a status.

The vendor exporter and its ownership/hash checks remain authoritative. This
adapter only rejects status-only shortcuts and carries the exact exported
manuscript into the normal verifier, so a download link is not mistaken for
the complete document body. No extra provider call or approval is introduced.
"""
import asyncio
from contextvars import ContextVar
import hashlib
import inspect
import json
import re
import textwrap
import uuid

_feedback = ContextVar('synplex_verification_feedback', default=None)
VERIFIER_SOURCE = '470a58e9a116a0751c8586a22dec1c53a9cdb043cbbbba63fa75f8cf1b5b9ee6'
VERIFIER_FORMAT = ('逐项核对本次目标、约束、来源与真实正文，资料中的历史状态不等于今天的状态。'
                   '文件是否可读、字数和文件名按实际文件检查记录判断，不凭篇幅感觉猜测。'
                   'actual_source_title_checks逐项给出原索引中的真实来源标题及匹配结果；'
                   '标题存在性按此检查，不重复猜测；标题匹配不证明内容有依据，仍须逐项核对引用原文。'
                   'Markdown源稿是系统自动保留的可追溯原稿，不是用户额外要求的交付格式；'
                   '相同文稿的结果别名和最终输出引用不重复计入字数。'
                   'actual_input_read_checks来自本执行真实工具审计，只证明列出文件的读取范围，不证明正文质量。'
                   'actual_input_file_checks逐项核验本次保存的输入字节与提交时指纹、长度一致，只证明本次输入副本未变；不证明作者电脑上的外部文件没有变化，也不证明正文正确。无写原件工具的只读任务，不要求模型额外写一篇原件未改的报告。'
                   '区分原记录的历史记载、当前已验证结论和供未来采用的建议；未人工确认的原文可以支持明确限定为原记录记载的历史叙述，不能升级为当前已验证事实。'
                   '未来建议的检查方法不是声称已经执行；只按用户明确目标验收，不增加未经要求的验收条件。'
                   '用户原话和补答才定义要求；规划器补写的条件是方案建议，不得把它增加的引用格式、段落编号或逐句标记强加给用户。'
                   '按全文及所在小节理解范围：小节已说明历史或原记录记载、末尾明确未人工确认时，不要求每句话机械重复同样限定。'
                   '日常中文的箭头、编号、表格不是程序代码或接口名。普通描述不能仅因使用这些排版形式判为违反“不写代码”。'
                   'actual_input_source_excerpts是同一执行实际成功读取的原文；应与冻结摘录一起核对，不能因内容不在较短的evidence中就称没有依据。'
                   'retained_source文件仅为系统留存，不属于额外交付；不能又以它在清单内为由判多交付格式。'
                   '以下只是判据示例，不是本任务事实：原文记载某年3次试用2成1败，正文在“当时试用记录”小节准确复述并注明来源，即为有据历史，不因未逐句重复“原记录”判失败；'
                   '若正文改称“当前全部成功”则必须判失败。用户只要求列来源，正文小节引用真实标题即可；未要求时，不能增设每句原文编号。'
                   '每个结论须有相应原文支持，但同一结论不要求每一份列出的来源都独立证明；没有依据的数字、遗漏的明确要求和历史冒充当前仍判失败。'
                   '约束限定行为，不自动增加写作内容：“保留负结果”指不删本次相关且有据的负结果，不要求为无关话题编造负面实例；“未知费用不填零”不要求无费用话题额外列费用。'
                   '明确标为待核对的经验建议可以列适用条件、动作与核对办法，不等于候选已获人工确认；准确转述历史记录也不等于声称当前已验证。'
                   '资料清单、出处小节与来源行都是有效引用位置；citations为空只说明没有识别到引用格式，不能推断标题不存在，应核对available_titles及title_mentions。'
                   '只返回JSON对象，不用代码围栏：'
                   '{"verdict":"PASS或FAIL","checks":[{"criterion":"条件","status":"PASS或FAIL","reason":"具体依据或缺口"}]}。'
                   '最多12项，每段文字最多200字；PASS必须所有项通过。不要把成功生成文件等同内容通过。')


def parse_verification(text):
    """Malformed, empty or contradictory reviews cannot approve a delivery."""
    try:
        value = json.loads(text)
        if not isinstance(value, dict) or set(value) != {'verdict', 'checks'}:
            return None
        checks = value['checks']
        if value['verdict'] not in {'PASS', 'FAIL'} or not isinstance(checks, list) or not 1 <= len(checks) <= 12:
            return None
        for check in checks:
            if (not isinstance(check, dict) or set(check) != {'criterion', 'status', 'reason'}
                    or check['status'] not in {'PASS', 'FAIL'}
                    or any(not isinstance(check[k], str) or not 1 <= len(check[k]) <= 200 for k in ['criterion', 'reason'])):
                return None
        if (value['verdict'] == 'PASS') != all(check['status'] == 'PASS' for check in checks):
            return None
        return value
    except (ValueError, TypeError):
        return None


def read_verification(text):
    value = parse_verification(text)
    if value is None:
        return 'UNKNOWN'
    _feedback.set(value)
    return value['verdict']


def verification_clients(clients):
    # Enforce valid JSON at the same request, not a paid repair or permissive
    # parser. The original model, thinking, output limit and gateway stay put.
    # ChatOpenAI translates response_format for both supported API protocols.
    from langchain_openai import ChatOpenAI
    return [client.model_copy(update={'model_kwargs': {
        **client.model_kwargs, 'response_format': {'type': 'json_object'}}})
        if isinstance(client, ChatOpenAI) else client for client in clients]


def manuscript_citations(manuscripts, titles):
    """Recognize source lists without imposing one spelling on the author."""
    cited, mentions = set(), set()
    for text in manuscripts:
        source_section = False
        for line in text.splitlines():
            names = re.findall(r'《([^》]+)》', line)
            mentions.update(names)
            heading = re.match(r'^\s*#{1,6}\s+(.+)', line)
            if heading:
                source_section = bool(re.search(r'来源|资料标题|参考资料|参考文献|出处', heading[1]))
            if source_section or re.match(r'^\s*(?:[-*+]\s+)?(?:\*\*)?(?:来源(?:标题)?|依据|出处)\s*[：:]', line):
                cited.update(names)
    return {'available_titles': sorted(titles),
            'citations': [{'title': title, 'exists': title in titles} for title in sorted(cited)],
            'title_mentions': [{'title': title, 'exists': title in titles} for title in sorted(mentions)],
            'scope': '仅核对标题存在性，不代表原文支持正文结论；title_mentions也可能是作品名，不自动作为来源'}


def install():
    install_export_title()
    install_document_planning()
    install_verification()
    from clarification_gate import install as install_clarification
    install_clarification()
    from document_completion import install as install_completion
    install_completion()
    from app.engine import document_step as module
    original = module.export_existing_manuscript
    if getattr(original, "synplex_document_body", False):
        return

    async def exported(state, step):
        # A source manuscript is not necessarily the requested final draft.
        # The fast path is restricted to an explicit, unchanged export. Any
        # editing/synthesis instruction stays with the normal document worker.
        instruction = str(step.get("description") or "")
        if (not re.search(r"原样导出|export (?:the )?(?:manuscript|text) unchanged", instruction, re.I)
                or re.search(r"新增|增加|补充|修改|修订|改写|合并|整理|总结|append|add|revise|rewrite|merge|summari", instruction, re.I)):
            return None
        outputs = state.get("node_outputs") or {}
        refs = step.get("input_refs") or step.get("depends_on") or []
        values = [outputs[ref] for ref in refs if ref not in module.INPUT_REFS and ref in outputs]
        if len(values) != 1 or not isinstance(values[0], str):
            return None
        content = values[0]
        sources = []
        for ref in refs:
            sources.extend(a for a in (state.get("step_artifacts") or {}).get(ref, [])
                           if a.get("format") == "md")
        if len(sources) > 1:
            return None
        if sources:
            async with module.async_session_factory() as session:
                row = await session.get(module.Artifact, uuid.UUID(sources[0]["id"]))
                if (not row or str(row.execution_id) != str(state.get("execution_id"))
                        or str(row.user_id) != str(state.get("user_id"))
                        or str(row.organization_id) != str(state.get("organization_id"))
                        or not await asyncio.to_thread(module.verify_artifact, row)):
                    raise PermissionError("Upstream manuscript identity or integrity mismatch")
                content = await asyncio.to_thread(module.artifact_path(row).read_text)
        # Tool receipts and worker fallback notices are not manuscripts. Let
        # the ordinary document worker handle them rather than making a bogus
        # Word file containing only 'no final text' or a download link.
        text = content.strip()
        if (len(text) < 80 or text.startswith(("未生成最终文本", "已按完整前置文稿导出", "任务已完成，但"))):
            return None
        result = await original(state, step)
        if result is not None and not result.get("blockers"):
            result = {**result, "output": content + "\n\n" + result["output"]}
        return result

    exported.synplex_document_body = True
    module.export_existing_manuscript = exported


def install_export_title():
    from app.artifacts import service
    original = service.export_document
    if getattr(original, 'synplex_export_title', False):
        return
    source = textwrap.dedent(inspect.getsource(original))
    if hashlib.sha256(source.encode()).hexdigest() != 'a9bfe58e075f3f765a12586def4355b2b09ed6dded6c1c9768bad5c95041f312':
        raise RuntimeError('Document exporter changed; reviewed title adapter required')

    async def exported(execution_id, user_id, organization_id, *, title, content, format):
        # Callers may provide a filename although the renderer takes a title.
        # Only strip a known terminal document suffix; normal dotted titles,
        # the manuscript and the original ownership/storage checks stay intact.
        title = re.sub(r'\.(?:docx|pdf|md)$', '', title.strip(), flags=re.I) or 'document'
        return await original(execution_id, user_id, organization_id,
                              title=title, content=content, format=format)

    exported.synplex_export_title = True
    exported.__wrapped__ = original
    service.export_document = exported


def install_document_planning():
    """Describe the installed reader to the planner; do not rewrite its plan."""
    from dataclasses import replace
    from app.engine import planner
    from app.engine.capabilities import CAPABILITIES
    if getattr(planner, 'synplex_document_reader', False):
        return
    capability = CAPABILITIES['document']
    for text, expected in [(planner.PLANNER_SYSTEM_PROMPT, '746646f3cff9764ae12108ffbb75b469077f91b6f6fbd5f287062a034734bb09'),
                           (capability.system_prompt, '07e93f8293e521b677518d96a9053d4ca29b772a78638aec196a72d7ac3eb7ab')]:
        if hashlib.sha256(text.encode()).hexdigest() != expected:
            raise RuntimeError('Document planning instructions changed; reviewed adapter required')
    # The scoped reader is installed before this adapter in the real runner.
    # The existing planner text otherwise describes document as export-only,
    # causing a separate general worker to write a long read report first.
    if any(tool.name == 'read_task_file' for tool in capability.tools):
        planner.PLANNER_SYSTEM_PROMPT += ('\n当前document能力已经连接read_task_file，可在同一文档子目标中读取本次授权原文件、'
            '按要求修订并export_document导出。对一份已有小型文稿的局部改稿，通常一个document步骤即可，'
            '不要另外安排general写一篇读取核对报告而不传原文。独立研究、不同交付或分别审批的操作仍保留独立步骤。'
            '系统在执行步骤结束后已经核对真实文件、输入指纹、用户原要求与正文；不要仅为重复这些内置核对另设general步骤。'
            '只有用户明确要求独立审计交付、专业研究或额外操作时才新增对应步骤；用户要求“可核对、原件不改、符合字数”本身不是第二份交付。')
        CAPABILITIES['document'] = replace(capability, system_prompt=capability.system_prompt +
            '\n只有用户本次明确要求修改已有文稿、且本次确有授权旧稿文件时，先用read_task_file读取该旧稿实际正文，再生成完整新稿并导出；'
            '从经验或资料摘录新写模板、报告不属于改稿，不要求寻找不存在的旧稿；直接使用本次已给出的原文依据。'
            '本次完整背景中的精确摘录可直接使用，不必重复读取已足够回答的原件；需要核对完整旧稿或摘录未覆盖内容时才读取。'
            '若确需多个文件，尽量在同一轮调用分别读取，减少重复发送相同背景；读取范围不足必须说明，不能假称读完。'
            '保留原要求、来源和未要求改动的正文。不要把读取报告或计划当成修订文稿，不必先写一篇读取总结。')
        planner.synplex_document_reader = True


async def verification_state(state):
    """Provide actual owned manuscript bytes to the original verifier.

    Download receipts are not document content. Keep original state and step
    history unchanged; only the verifier's view references exact duplicate
    aliases and includes the current execution's verified source manuscripts.
    """
    from app.engine import document_step as module
    outputs, seen = {}, {}
    import hashlib
    for key, value in (state.get('node_outputs') or {}).items():
        fingerprint = hashlib.sha256(value.encode()).hexdigest() if isinstance(value, str) else None
        if fingerprint is not None and fingerprint in seen:
            outputs[key] = {'same_as': seen[fingerprint], 'sha256': fingerprint}
        else:
            outputs[key] = value
            if fingerprint is not None:
                seen[fingerprint] = key
    inspected, manuscripts = [], []
    from document_completion import requested_formats
    requested = {fmt for step in state.get('plan') or [] for fmt in requested_formats(step)}
    retained_ids = {a['id'] for a in state.get('artifacts') or []
                    if a.get('format') == 'md' and 'md' not in requested
                    and any(b.get('format') in {'docx', 'pdf'}
                            and b.get('filename', '').rsplit('.', 1)[0] == a.get('filename', '').rsplit('.', 1)[0]
                            and a.get('filename') for b in state.get('artifacts') or [])}
    for artifact in state.get('artifacts') or []:
        async with module.async_session_factory() as session:
            row = await session.get(module.Artifact, uuid.UUID(artifact['id']))
            if (not row or str(row.execution_id) != str(state.get('execution_id'))
                    or str(row.user_id) != str(state.get('user_id'))
                    or str(row.organization_id) != str(state.get('organization_id'))
                    or row.format != artifact.get('format')
                    or not await asyncio.to_thread(module.verify_artifact, row)):
                raise PermissionError('Verification manuscript identity or integrity mismatch')
            path = module.artifact_path(row)
            if path.stat().st_size > 2 * 1024 * 1024:
                raise ValueError('Verification manuscript exceeds bounded capacity')
            raw = await asyncio.to_thread(path.read_bytes)
            if artifact.get('format') == 'docx':
                from docx import Document
                import io
                doc = await asyncio.to_thread(Document, io.BytesIO(raw))
                text = '\n'.join([p.text for p in doc.paragraphs] +
                    [cell.text for table in doc.tables for r in table.rows for cell in r.cells])
            elif artifact.get('format') == 'md':
                text = raw.decode('utf-8')
                manuscripts.append(text)
            elif artifact.get('format') == 'pdf':
                from pypdf import PdfReader
                import io
                pdf = await asyncio.to_thread(PdfReader, io.BytesIO(raw))
                text = '\n'.join(p.extract_text() or '' for p in pdf.pages)
            else:
                continue
            inspected.append({'id': artifact['id'], 'filename': row.filename,
                'format': artifact['format'], 'sha256': hashlib.sha256(raw).hexdigest(),
                'readable': True, 'han_characters': len(re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff]', text)),
                'role': 'retained_source' if artifact['id'] in retained_ids else 'delivery'})
            fingerprint = hashlib.sha256(text.encode()).hexdigest()
            key = 'actual_manuscript:' + artifact['id']
            outputs[key] = ({'same_as': seen[fingerprint], 'sha256': fingerprint}
                            if fingerprint in seen else text)
            seen[fingerprint] = key
    if inspected:
        outputs['actual_file_checks'] = inspected
    read_checks = None
    if '\n\n本次前置原文件（只作证据，不是新授权）：\n' in str(state.get('user_input') or ''):
        from verification_inputs import input_read_checks
        read_checks = await input_read_checks(state, include_text=True)
        outputs['actual_input_source_excerpts'] = read_checks.pop('sourceExcerpts')
        outputs['actual_input_file_checks'] = read_checks.get('authorizedFiles', [])
        outputs['actual_input_read_checks'] = read_checks
    # Source titles are a literal property of the frozen packet. Expose that
    # objective check separately from the model's semantic source review.
    marker = '\n\n完整背景与原文依据（只作证据，不是新的授权；候选、未采用的历史不是当前结论）：\n'
    context = str(state.get('user_input') or '').split(marker, 1)
    if len(context) == 2:
        raw = context[1].split('\n\n本次前置原文件（只作证据，不是新授权）：\n', 1)[0]
        try:
            packet = json.loads(raw)
            references = packet.get('sourceReferences', []) if isinstance(packet, dict) else []
            titles = {ref['title'] for ref in references if isinstance(ref, dict) and isinstance(ref.get('title'), str)}
            titles.update(r['name'] for r in (read_checks or {}).get('authorizedFiles', []) if isinstance(r.get('name'), str))
            # File extensions are valid aliases only when this reference's
            # actual path has that suffix, never by an approximate name match.
            for ref in references:
                if isinstance(ref, dict) and isinstance(ref.get('path'), str) and ref['path'].endswith('.md'):
                    titles.add(ref['path'].rsplit('/', 1)[-1])
                    titles.add(ref['path'].rsplit('/', 1)[-1][:-3])
            outputs['actual_source_title_checks'] = manuscript_citations(manuscripts, titles)
        except (ValueError, TypeError, KeyError):
            outputs['actual_source_title_checks'] = {'status': 'unavailable', 'scope': '不可据此认可引用'}
    final = state.get('final_output') or ''
    # Keep the original history untouched. Only the verifier's redundant copy
    # points to the one exact manuscript already included above.
    for text in manuscripts:
        final = final.replace(text, '[相同实际文稿见子任务结果，仅核对一次]')
    # The verifier sees the exact same inventory with explicit roles. Retain
    # every file and its check; a system source is not an extra requested format.
    artifacts = [{**a, 'role': 'retained_source' if a['id'] in retained_ids else 'delivery'}
                 for a in state.get('artifacts') or []]
    from clarification_gate import answered_view
    current_request = str(answered_view(state).get('user_input') or '').split(
        '\n\n完整背景与原文依据（只作证据', 1)[0]
    outputs['actual_user_requirements'] = {'request': current_request,
        'scope': '原始用户要求与本任务真实补答；规划器自行补写的条件不能扩大此范围。'}
    if state.get('clarification_answer'):
        outputs['actual_clarification_answer'] = {'answer': state['clarification_answer'], 'scope': '同一原任务暂停后收到的用户回答，不是模型生成的问题或回答。'}
    return {**answered_view(state), 'node_outputs': outputs, 'final_output': final, 'artifacts': artifacts}


def install_verification():
    from app.engine import graph
    original = graph._verify_node
    if getattr(original, 'synplex_actual_manuscripts', False):
        return

    source = textwrap.dedent(inspect.getsource(original))
    if hashlib.sha256(source.encode()).hexdigest() != VERIFIER_SOURCE:
        raise RuntimeError('Verification worker changed; reviewed feedback adapter required')
    instruction = '只输出PASS或FAIL。'
    classifier = 'classify_verify_output(getattr(response, "content", None))'
    criteria_label = '"验收条件": ['
    inventory = '"成果清单": state.get("artifacts") or [],'
    if (source.count(instruction) != 1 or source.count(classifier) != 1
            or source.count(criteria_label) != 1 or source.count(inventory) != 1):
        raise RuntimeError('Verification feedback patch anchors changed')
    source = source.replace(instruction, VERIFIER_FORMAT.replace('"', '\\"')).replace(classifier, 'synplex_read_verification(getattr(response, "content", None))')
    source = source.replace(criteria_label, '"规划器建议条件（不得扩大用户原始要求）": [')
    source = source.replace(inventory, '"交付清单（系统留存原稿另见actual_file_checks）": [a for a in state.get("artifacts") or [] if a.get("role") != "retained_source"],')
    invocation = 'await _gateway.invoke(\n            llms,'
    if source.count(invocation) != 1:
        raise RuntimeError('Verification request adapter anchor changed')
    source = source.replace(invocation, 'await _gateway.invoke(\n            synplex_verification_clients(llms),')
    namespace = {**vars(graph), 'synplex_read_verification': read_verification,
                 'synplex_verification_clients': verification_clients}
    exec(compile(source, __file__ + ':evaluated-verification-feedback', 'exec'), namespace)
    checked = namespace['_verify_node']

    async def verified(state):
        token = _feedback.set(None)
        try:
            result = await checked(await verification_state(state))
            if 'final_output' in result:
                result['final_output'] = state.get('final_output') or ''
            feedback = _feedback.get()
            if feedback:
                await graph.audit_execution_event(execution_id=str(state.get('execution_id') or ''),
                    action='verification_feedback', organization_id=state.get('organization_id'),
                    user_id=state.get('user_id'), details=feedback)
            if result.get('verification_status') == 'FAIL':
                # The upstream graph permits only one verifier call. Replanning
                # after it cannot be certified and may replay an identical paid
                # request. Keep the failed file and offer an explicit revision.
                reasons = [c['criterion'] + '：' + c['reason'] for c in (feedback or {}).get('checks', []) if c['status'] == 'FAIL']
                result.update(revision_requested=False, revision_count=state.get('revision_count', 0),
                    current_step=state.get('current_step', 0),
                    final_output=(state.get('final_output') or '') + '\n\n核对未通过：\n' + '\n'.join(reasons))
            return result
        finally:
            _feedback.reset(token)

    verified.synplex_actual_manuscripts = True
    verified.__wrapped__ = checked
    graph._verify_node = verified
