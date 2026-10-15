"""Explicit private-route priority without depending on FastAPI internals."""
import re
from starlette.responses import JSONResponse


def include_first(app, router):
    # Both flattened and lazily included FastAPI routes are accepted. Match
    # priority is public list order; never inspect/mutate a shared child router.
    previous = list(app.router.routes)
    app.include_router(router)
    added = app.router.routes[len(previous):]
    app.router.routes[:] = [*added, *previous]


class ApprovalBoundary:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (scope["type"] == "http" and scope["method"] == "POST"
                and re.fullmatch(r"/api/(executions/[^/]+/(resume|intervene)|tool_calls/[^/]+/(approve|reject))/?", scope["path"])):
            response = JSONResponse({"detail": "请在原任务中查看并确认本次操作。旧确认方式已停用，任务没有重新执行。"}, status_code=404)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)
