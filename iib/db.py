"""IIB 索引库：SQLite 表结构与常用查询。"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from typing import Any, Iterable, List, Optional

from .config import data_dir

_LOCK = threading.RLock()

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    root_id TEXT,
    rel TEXT,
    name TEXT,
    ext TEXT,
    kind TEXT,
    size INTEGER DEFAULT 0,
    mtime REAL DEFAULT 0,
    width INTEGER DEFAULT 0,
    height INTEGER DEFAULT 0,
    prompt TEXT DEFAULT '',
    negative TEXT DEFAULT '',
    model TEXT DEFAULT '',
    loras TEXT DEFAULT '',
    sampler TEXT DEFAULT '',
    steps INTEGER DEFAULT 0,
    cfg REAL DEFAULT 0,
    seed TEXT DEFAULT '',
    phash TEXT DEFAULT '',
    indexed_at REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime);
CREATE INDEX IF NOT EXISTS idx_files_model ON files(model);
CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
CREATE INDEX IF NOT EXISTS idx_files_size ON files(size);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '',
    created_at REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_tags (
    file_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    source TEXT DEFAULT 'manual',
    PRIMARY KEY (file_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);

CREATE TABLE IF NOT EXISTS dirs (
    path TEXT PRIMARY KEY,
    mtime REAL DEFAULT 0,
    scanned_at REAL DEFAULT 0,
    file_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scan_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started REAL DEFAULT 0,
    finished REAL DEFAULT 0,
    added INTEGER DEFAULT 0,
    updated INTEGER DEFAULT 0,
    removed INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS favorites (
    path TEXT PRIMARY KEY,
    created_at REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_favorites_created ON favorites(created_at);
"""


def db_path() -> str:
    return os.path.join(data_dir(), "index.db")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(), timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init() -> None:
    with _LOCK:
        conn = connect()
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()


def get_meta(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def file_count(conn: Optional[sqlite3.Connection] = None) -> int:
    own = conn is None
    conn = conn or connect()
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM files").fetchone()
        return int(row["c"] if row else 0)
    finally:
        if own:
            conn.close()


def upsert_file(conn: sqlite3.Connection, data: dict) -> int:
    columns = [
        "path", "root_id", "rel", "name", "ext", "kind", "size", "mtime",
        "width", "height", "prompt", "negative", "model", "loras", "sampler",
        "steps", "cfg", "seed", "phash", "indexed_at",
    ]
    values = [data.get(column) for column in columns]
    placeholders = ",".join("?" for _ in columns)
    updates = ",".join(f"{column}=excluded.{column}" for column in columns if column != "path")
    conn.execute(
        f"INSERT INTO files({','.join(columns)}) VALUES({placeholders}) "
        f"ON CONFLICT(path) DO UPDATE SET {updates}",
        values,
    )
    row = conn.execute("SELECT id FROM files WHERE path=?", (data.get("path"),)).fetchone()
    return int(row["id"]) if row else 0


def get_file(conn: sqlite3.Connection, path: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM files WHERE path=?", (path,)).fetchone()


def remove_file(conn: sqlite3.Connection, path: str) -> None:
    row = conn.execute("SELECT id FROM files WHERE path=?", (path,)).fetchone()
    if row:
        conn.execute("DELETE FROM file_tags WHERE file_id=?", (row["id"],))
        conn.execute("DELETE FROM files WHERE id=?", (row["id"],))


def ensure_tag(conn: sqlite3.Connection, name: str, color: str = "") -> int:
    name = (name or "").strip()
    if not name:
        return 0
    row = conn.execute("SELECT id FROM tags WHERE name=?", (name,)).fetchone()
    if row:
        return int(row["id"])
    cursor = conn.execute("INSERT INTO tags(name, color, created_at) VALUES(?,?,?)", (name, color, time.time()))
    return int(cursor.lastrowid)


def assign_tag(conn: sqlite3.Connection, file_id: int, tag_id: int, source: str = "manual") -> None:
    if not file_id or not tag_id:
        return
    conn.execute(
        "INSERT INTO file_tags(file_id, tag_id, source) VALUES(?,?,?) ON CONFLICT(file_id, tag_id) DO NOTHING",
        (file_id, tag_id, source),
    )


def unassign_tag(conn: sqlite3.Connection, file_id: int, tag_id: int) -> None:
    conn.execute("DELETE FROM file_tags WHERE file_id=? AND tag_id=?", (file_id, tag_id))


def tags_of_file(conn: sqlite3.Connection, file_id: int) -> List[dict]:
    rows = conn.execute(
        "SELECT t.id, t.name, t.color, ft.source FROM tags t "
        "JOIN file_tags ft ON ft.tag_id=t.id WHERE ft.file_id=? ORDER BY t.name",
        (file_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def list_tags(conn: sqlite3.Connection, query: str = "", limit: int = 500, sort: str = "count") -> List[dict]:
    order = "c DESC, t.name" if sort == "count" else "t.name"
    sql = (
        "SELECT t.id, t.name, t.color, COUNT(ft.file_id) AS c FROM tags t "
        "LEFT JOIN file_tags ft ON ft.tag_id=t.id "
    )
    params: List[Any] = []
    if query:
        sql += "WHERE t.name LIKE ? "
        params.append(f"%{query}%")
    sql += f"GROUP BY t.id ORDER BY {order} LIMIT ?"
    params.append(max(1, min(int(limit or 500), 5000)))
    return [dict(row) for row in conn.execute(sql, params).fetchall()]


def delete_tag(conn: sqlite3.Connection, tag_id: int) -> None:
    conn.execute("DELETE FROM file_tags WHERE tag_id=?", (tag_id,))
    conn.execute("DELETE FROM tags WHERE id=?", (tag_id,))


def rename_tag(conn: sqlite3.Connection, tag_id: int, new_name: str) -> bool:
    new_name = (new_name or "").strip()
    if not new_name:
        return False
    try:
        conn.execute("UPDATE tags SET name=? WHERE id=?", (new_name, tag_id))
        return True
    except sqlite3.IntegrityError:
        return False


def stats_summary(conn: sqlite3.Connection, days: int = 30) -> dict:
    total = conn.execute("SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM files").fetchone()
    by_kind = [dict(row) for row in conn.execute("SELECT kind, COUNT(*) c FROM files GROUP BY kind ORDER BY c DESC")]
    since = time.time() - days * 86400
    by_day = [dict(row) for row in conn.execute(
        "SELECT strftime('%Y-%m-%d', mtime, 'unixepoch', 'localtime') d, COUNT(*) c "
        "FROM files WHERE mtime>=? GROUP BY d ORDER BY d",
        (since,),
    )]
    top_models = [dict(row) for row in conn.execute(
        "SELECT model, COUNT(*) c FROM files WHERE model<>'' GROUP BY model ORDER BY c DESC LIMIT 12"
    )]
    top_tags = [dict(row) for row in conn.execute(
        "SELECT t.name, COUNT(*) c FROM tags t JOIN file_tags ft ON ft.tag_id=t.id "
        "GROUP BY t.id ORDER BY c DESC LIMIT 40"
    )]
    return {
        "total": int(total["c"] if total else 0),
        "bytes": int(total["s"] if total else 0),
        "byKind": by_kind,
        "byDay": by_day,
        "topModels": top_models,
        "topTags": top_tags,
    }


def tag_graph(conn: sqlite3.Connection, limit: int = 60, min_edge: int = 2) -> dict:
    """标签共现图：节点 + 边。"""
    rows = conn.execute(
        "SELECT a.tag_id a, b.tag_id b, COUNT(*) c FROM file_tags a JOIN file_tags b "
        "ON a.file_id=b.file_id AND a.tag_id<b.tag_id GROUP BY a.tag_id, b.tag_id HAVING c>=? "
        "ORDER BY c DESC LIMIT 800",
        (max(1, int(min_edge)),),
    ).fetchall()
    weights: dict = {}
    for row in rows:
        weights[int(row["a"])] = weights.get(int(row["a"]), 0) + int(row["c"])
        weights[int(row["b"])] = weights.get(int(row["b"]), 0) + int(row["c"])
    top = sorted(weights.items(), key=lambda item: item[1], reverse=True)[: max(5, int(limit))]
    allowed = {tag_id for tag_id, _ in top}
    names = {
        int(row["id"]): row["name"]
        for row in conn.execute("SELECT id, name FROM tags").fetchall()
    }
    nodes = [
        {"id": tag_id, "name": names.get(tag_id, str(tag_id)), "weight": weight}
        for tag_id, weight in top if tag_id in names
    ]
    edges = [
        {"source": int(row["a"]), "target": int(row["b"]), "weight": int(row["c"])}
        for row in rows if int(row["a"]) in allowed and int(row["b"]) in allowed
    ]
    return {"nodes": nodes, "edges": edges}


def iter_files(conn: sqlite3.Connection, limit: int = 100000) -> Iterable[sqlite3.Row]:
    for row in conn.execute("SELECT * FROM files ORDER BY mtime DESC LIMIT ?", (int(limit),)):
        yield row
