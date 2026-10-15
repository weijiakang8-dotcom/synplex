"""Re-embed all tenant documents with the configured embedding provider.

用法（在 backend 容器/环境内）：
    python -m app.reembed_cli

用途：切换 EMBEDDING_PROVIDER 后，用新向量重建 document_chunks。
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.database import async_session_factory
from app.models import Document
from app.rag.vector_store import rebuild_document_chunks


async def main() -> None:
    async with async_session_factory() as session:
        documents = list((await session.execute(select(Document))).scalars().all())
    if not documents:
        print("no documents to re-embed")
        return
    for document in documents:
        count = await rebuild_document_chunks(document)
        print(f"re-embedded document={document.id} name={document.name} chunks={count}")
    print("re-embed complete")


if __name__ == "__main__":
    asyncio.run(main())
