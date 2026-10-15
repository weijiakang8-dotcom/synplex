from __future__ import annotations

import asyncio
import hashlib
import io
import os
import re
import uuid
from pathlib import Path
from xml.sax.saxutils import escape

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.database import async_session_factory
from app.models import Execution
from app.models.artifact import Artifact

MIME_TYPES = {
    "md": "text/markdown",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def render_document(title: str, content: str, format: str) -> bytes:
    if not content.strip() or len(content) > 250_000:
        raise ValueError("文稿为空或超过 250000 字符，请拆分后导出。")
    # The renderer already supplies the title. Drop only a matching opening H1,
    # preserving later headings and every body paragraph.
    lines = content.splitlines()
    first = next((i for i, line in enumerate(lines) if line.strip()), None)
    if first is not None and lines[first].strip() == f"# {title.strip()}":
        content = "\n".join(lines[first + 1 :]).lstrip("\n")
    if format == "md":
        return (f"# {title}\n\n{content}").encode()
    if format == "docx":
        from docx import Document
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        from docx.shared import Inches, Pt, RGBColor

        doc = Document()
        section = doc.sections[0]
        section.top_margin = section.bottom_margin = Inches(0.65)
        section.left_margin = section.right_margin = Inches(0.75)
        cjk_font = (
            "Arial Unicode MS"
            if Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf").exists()
            else "WenQuanYi Zen Hei"
        )
        style_sizes = {
            "Normal": 11,
            "Title": 18,
            "Heading 1": 14,
            "Heading 2": 14,
            "Heading 3": 14,
            "List Bullet": 11,
            "List Number": 11,
            "Quote": 11,
        }
        for name, size in style_sizes.items():
            style = doc.styles[name]
            style.font.name = "Arial"
            style.font.color.rgb = RGBColor(0, 0, 0)
            style.font.size = Pt(size)
            style.paragraph_format.space_after = Pt(4)
            style.paragraph_format.line_spacing = 1.12
            rpr = style.element.get_or_add_rPr()
            fonts = rpr.find(qn("w:rFonts"))
            if fonts is None:
                fonts = OxmlElement("w:rFonts")
                rpr.append(fonts)
            fonts.set(qn("w:eastAsia"), cjk_font)
            ppr = style.element.get_or_add_pPr()
            for border in list(ppr.findall(qn("w:pBdr"))):
                ppr.remove(border)
        doc.add_heading(title, 0)
        lines, index = content.splitlines(), 0
        while index < len(lines):
            line = lines[index]
            index += 1
            if not line.strip():
                continue
            if line.strip() == "<!-- pagebreak -->":
                doc.add_page_break()
                continue
            if (
                line.startswith("|")
                and index < len(lines)
                and re.fullmatch(r"[\s|:\-]+", lines[index])
            ):
                rows = [line]
                index += 1
                while index < len(lines) and lines[index].strip().startswith("|"):
                    rows.append(lines[index])
                    index += 1
                cells = [
                    [c.strip() for c in row.strip().strip("|").split("|")]
                    for row in rows
                ]
                table = doc.add_table(
                    rows=len(cells), cols=max(len(row) for row in cells)
                )
                table.style = "Table Grid"
                for row, values in zip(table.rows, cells, strict=True):
                    for cell, value in zip(row.cells, values):
                        cell.text = re.sub(r"\*\*(.+?)\*\*", r"\1", value)
                continue
            line = re.sub(r"\*\*(.+?)\*\*", r"\1", line)
            if line.startswith("#"):
                heading = line.lstrip("# ")
                if heading != title:
                    doc.add_heading(heading, min(len(line) - len(line.lstrip("#")), 3))
            elif not re.fullmatch(r"[-*_]{3,}", line.strip()):
                # Markdown 列表与引用必须转成真正的段落样式，
                # 否则 "- " / "> " 会作为普通文字出现在 Word 正文里。
                quote = re.match(r"^\s*>\s?(.*)$", line)
                bullet = re.match(r"^\s*[-*+]\s+(.*)$", line)
                numbered = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
                if quote:
                    doc.add_paragraph(quote.group(1), style="Quote")
                elif bullet:
                    doc.add_paragraph(bullet.group(1), style="List Bullet")
                elif numbered:
                    doc.add_paragraph(numbered.group(1), style="List Number")
                else:
                    doc.add_paragraph(line)
        buf = io.BytesIO()
        doc.save(buf)
        # Reopen before publishing.
        Document(io.BytesIO(buf.getvalue()))
        return buf.getvalue()
    if format != "pdf":
        raise ValueError("Unsupported document format")
    from pypdf import PdfReader
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    paths = [
        settings.PDF_CJK_FONT_PATH,
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
    ]
    font_path = next((path for path in paths if path and Path(path).is_file()), None)
    font_name = "STSong-Light"
    if font_path:
        font_name = "SynplexCJK"
        if font_name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(font_name, font_path, subfontIndex=0))
    else:
        pdfmetrics.registerFont(UnicodeCIDFont(font_name))
    pdfmetrics.registerFontFamily(
        font_name,
        normal=font_name,
        bold=font_name,
        italic=font_name,
        boldItalic=font_name,
    )
    style = ParagraphStyle(
        "Chinese",
        fontName=font_name,
        fontSize=11,
        leading=17,
        wordWrap="CJK",
        spaceAfter=4,
    )
    title_style = ParagraphStyle(
        "Title", parent=style, fontSize=20, leading=27, spaceAfter=16
    )
    heading_style = ParagraphStyle(
        "Heading",
        parent=style,
        fontSize=14,
        leading=20,
        spaceBefore=12,
        spaceAfter=6,
        keepWithNext=True,
    )
    code_style = ParagraphStyle(
        "Code",
        parent=style,
        fontSize=9,
        leading=13,
        backColor=colors.HexColor("#f4f5f7"),
    )
    table_style = ParagraphStyle("Cell", parent=style, fontSize=9, leading=13)
    quote_style = ParagraphStyle(
        "Quote", parent=style, leftIndent=18, textColor=colors.HexColor("#3f4652")
    )

    def inline(text):
        # Escape user HTML; only generate this limited known markup.
        return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", escape(text))

    buf = io.BytesIO()
    story = [Paragraph(escape(title), title_style)]
    lines, index, code = content.splitlines(), 0, False
    while index < len(lines):
        line = lines[index]
        index += 1
        if line.startswith("```"):
            code = not code
            story.append(Spacer(1, 6))
            continue
        if code:
            story.append(
                Paragraph(escape(line).replace(" ", "&#160;") or "&#160;", code_style)
            )
            continue
        heading = re.match(r"^#{1,6}\s+(.+)$", line)
        if heading:
            story.append(Paragraph(inline(heading[1]), heading_style))
        elif (
            line.strip().startswith("|")
            and index < len(lines)
            and re.fullmatch(r"[\s|:\-]+", lines[index])
        ):
            rows = [line]
            index += 1  # Markdown header separator.
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append(lines[index])
                index += 1
            cells = [
                [
                    Paragraph(inline(cell.strip()), table_style)
                    for cell in row.strip().strip("|").split("|")
                ]
                for row in rows
            ]
            columns = max(len(row) for row in cells)
            for row in cells:
                row.extend([""] * (columns - len(row)))
            table = Table(
                cells, colWidths=[451 / columns] * columns, repeatRows=1, hAlign="LEFT"
            )
            table.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef1f5")),
                        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd0d8")),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ]
                )
            )
            story.extend([table, Spacer(1, 8)])
        elif not line.strip():
            story.append(Spacer(1, 5))
        else:
            bullet = re.match(r"^\s*[-*]\s+(.+)$", line)
            quote = re.match(r"^\s*>\s?(.*)$", line)
            if bullet:
                story.append(Paragraph(inline(bullet[1]), style, bulletText="•"))
            elif quote:
                story.append(Paragraph(inline(quote[1]), quote_style))
            else:
                story.append(Paragraph(inline(line), style))
    SimpleDocTemplate(buf, title=title, author="Synplex").build(story)
    result = buf.getvalue()
    if not PdfReader(io.BytesIO(result)).pages:
        raise ValueError("PDF contains no pages")
    return result


def artifact_path(row: Artifact) -> Path:
    # No user or model supplied path ever enters the filesystem.
    return (
        Path(settings.ARTIFACT_ROOT)
        / str(row.execution_id)
        / f"{row.sha256}.{row.format}"
    )


def public_artifact(row: Artifact, *, verified: bool = False) -> dict:
    return {
        "id": str(row.id),
        "filename": row.filename,
        "format": row.format,
        "size": row.size,
        "sha256": row.sha256,
        "download_url": f"/api/artifacts/{row.id}/download",
        "verified": verified,
    }


def verify_artifact(row: Artifact) -> bool:
    """Check bytes and readability, not a model assertion or a filename."""
    try:
        data = artifact_path(row).read_bytes()
        if (
            not data
            or len(data) != row.size
            or hashlib.sha256(data).hexdigest() != row.sha256
        ):
            return False
        if row.format == "pdf":
            from pypdf import PdfReader

            return bool(PdfReader(io.BytesIO(data)).pages)
        if row.format == "docx":
            from docx import Document

            document = Document(io.BytesIO(data))
            return bool(document.paragraphs or document.tables)
        return row.format == "md" and bool(data.decode("utf-8").strip())
    except Exception:  # noqa: BLE001 -- malformed documents are unverified evidence
        return False


async def export_document(
    execution_id: str,
    user_id: str,
    organization_id,
    *,
    title: str,
    content: str,
    format: str,
) -> dict:
    data = await asyncio.to_thread(render_document, title, content, format)
    digest = hashlib.sha256(data).hexdigest()
    async with async_session_factory() as session:
        execution = await session.get(Execution, uuid.UUID(execution_id))
        if (
            not execution
            or str(execution.user_id) != str(user_id)
            or execution.organization_id != organization_id
        ):
            raise PermissionError("Artifact execution permission denied")
        stmt = select(Artifact).where(
            Artifact.execution_id == execution.id,
            Artifact.sha256 == digest,
            Artifact.format == format,
        )
        existing = (await session.execute(stmt)).scalar_one_or_none()
        if existing:
            if not await asyncio.to_thread(verify_artifact, existing):
                raise ValueError(
                    "Artifact storage invalid; restore or re-export the source"
                )
            return public_artifact(existing, verified=True)
        filename = re.sub(r"[^\w\- .]", "_", title)[:180].strip(". ") or "document"
        row = Artifact(
            execution_id=execution.id,
            user_id=execution.user_id,
            organization_id=execution.organization_id,
            filename=f"{filename}.{format}",
            format=format,
            sha256=digest,
            size=len(data),
        )
        path = artifact_path(row)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        session.add(row)
        try:
            await session.commit()
            await session.refresh(row)
        except IntegrityError:
            await session.rollback()
            row = (await session.execute(stmt)).scalar_one()
        return public_artifact(row, verified=True)


async def artifact_inventory(
    execution_id, user_id, organization_id
) -> tuple[list[dict], int]:
    """Read durable delivery evidence using the execution's full tenant identity."""
    if not user_id:
        return [], 0
    async with async_session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(Artifact).where(
                        Artifact.execution_id == uuid.UUID(str(execution_id)),
                        Artifact.user_id == uuid.UUID(str(user_id)),
                        Artifact.organization_id == organization_id,
                    )
                )
            )
            .scalars()
            .all()
        )
    verified = await asyncio.gather(
        *[asyncio.to_thread(verify_artifact, row) for row in rows]
    )
    available = [
        public_artifact(row, verified=True)
        for row, valid in zip(rows, verified, strict=True)
        if valid
    ]
    return available, len(rows) - len(available)
