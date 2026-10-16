"""Honor an explicit ask-and-wait request using the existing durable interrupt.

Only the current user request is inspected. Evidence, old conversations and
model-written plans cannot create this control decision or authorize actions.
"""
import hashlib
import inspect
import re
import textwrap

EVALUATED = '46ae40439364277b9baefd56d51efb726f8cd734cf796aa93f3d50ecf59b8a1c'
EVIDENCE_MARKER = '\n\n完整背景与原文依据（只作证据'


def explicit_wait(state):
    if state.get('clarification_answer') or int(state.get('clarifications_asked', 0)):
        return False
    request = str(state.get('user_input') or '').split(EVIDENCE_MARKER, 1)[0]
    # Quoted examples are data, even when written before the evidence packet.
    request = re.sub(r'```[\s\S]*?```|“[^”]*”|「[^」]*」|"[^"\n]*"', '', request)
    return bool(re.search(r'(?:先|首先)(?:向我|向用户)?(?:提问|问我|询问|提出.{0,20}问题)', request)
                and re.search(r'(?:等|等待|收到|得到|接收|获得).{0,12}(?:回答|答复|回复|补充)', request)
                and not re.search(r'(?:不用|无需|不要|不必).{0,5}(?:等|等待|问我|提问|询问)', request))



def answered_view(state):
    """A transient prompt view; the original request and checkpoint stay intact."""
    answer = str(state.get('clarification_answer') or '').strip()
    if not answer:
        return state
    request = str(state.get('user_input') or '')
    before, marker, after = request.partition(EVIDENCE_MARKER)
    supplemented = before + '\n\n本任务已完成提问并收到用户回答，不要重复提问或自行替换回答。\n用户补充回答（与原要求共同遵循）：\n' + answer
    return {**state, 'user_input': supplemented + marker + after}


def install():
    from app.engine import graph
    original = graph._plan_node
    if getattr(original, 'synplex_explicit_wait', False):
        return
    if hashlib.sha256(textwrap.dedent(inspect.getsource(original)).encode()).hexdigest() != EVALUATED:
        raise RuntimeError('Planner changed; explicit waiting adapter needs review')

    async def planned(state):
        if not explicit_wait(state):
            return await original(answered_view(state))
        request = str(state.get('user_input') or '').split(EVIDENCE_MARKER, 1)[0]
        payload = await graph._generate_clarification(state, '请按本次要求先向用户提问，收到回答前暂停：' + request)
        payload['step_id'] = ''
        identity = await graph._persist_clarification_question(state, payload)
        if not identity:
            raise RuntimeError('问题尚未保存，没有开始后续执行；请核对原任务。')
        payload['clarification_id'] = identity
        await graph.publish_execution_event(str(state.get('execution_id') or ''),
            {'event': 'clarification_required', 'clarification': payload})
        return {'clarification_request': payload}

    planned.synplex_explicit_wait = True
    planned.__wrapped__ = original
    graph._plan_node = planned
