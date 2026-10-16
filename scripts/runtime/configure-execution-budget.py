"""Inspect or set the original private engine's monthly limits; never sends a model request."""
import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'integrations/agenthub'))


async def configure(root, tokens, cost):
    from engine_runtime import configuration
    from local_runner import load_config, private_json
    saved, _, original = configuration(root)
    data = load_config(root / 'engine', Path(saved['backend']))
    if data['organization_id'] != original['organization_id']:
        raise RuntimeError('执行环境身份不一致。')
    from app.core.quota import quota_usage, set_quota_limits
    organization = data['organization_id']
    before = await quota_usage(organization)
    if tokens is not None or cost is not None:
        # Preserve the intent and previous limits, even if the queue connection
        # drops after Redis accepted the change. Never reset usage counters.
        receipt = root / ('budget-change-' + uuid.uuid4().hex + '.json')
        intent = {'format': 'synplex.execution-budget-change/1', 'organizationId': organization,
                  'createdAt': datetime.now(timezone.utc).isoformat(), 'before': before,
                  'requested': {'tokens': tokens, 'costCny': cost}, 'status': 'prepared', 'modelCalls': 0}
        private_json(receipt, intent)
        await set_quota_limits(organization, monthly_token_budget=tokens, monthly_cost_budget_cny=cost)
        after = await quota_usage(organization)
        private_json(receipt, {**intent, 'status': 'applied', 'after': after})
    else:
        after = before
    print(json.dumps({key: after[key] for key in ['month', 'monthly_token_used', 'monthly_token_budget',
          'monthly_cost_used_cny', 'monthly_cost_budget_cny', 'concurrent_llm_calls', 'concurrent_llm_limit']}, ensure_ascii=False))
    print('这是工作台执行限额，不是服务商余额或实付费用；没有清空用量，也没有调用模型。')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--tokens', type=int)
    parser.add_argument('--cost-cny', type=float)
    args = parser.parse_args()
    if args.tokens is not None and not 1 <= args.tokens <= 100_000_000:
        parser.error('token限额需在1到100000000之间，不能取消保护。')
    if args.cost_cny is not None and not 0 < args.cost_cny <= 10000:
        parser.error('参考费用限额需大于0且不超过10000元；不能作为实付凭据。')
    try:
        asyncio.run(configure(args.engine.absolute(), args.tokens, args.cost_cny))
    except Exception:
        print('无法核对或保存执行限额。保留原环境与变更记录，请检查执行服务和原始身份。', file=sys.stderr)
        sys.exit(1)
