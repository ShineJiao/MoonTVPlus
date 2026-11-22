#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
国漫在更/放送日历聚合器（B站国创 / 腾讯视频动漫 / 优酷动漫）

能做什么
--------
1) B站：使用游客可访问的公开接口
   - 国创「连载中」索引  api.bilibili.com/pgc/season/index/result
   - 国创「每周放送表」  api.bilibili.com/pgc/web/timeline
   两者合并后即可得到「哪部在更 / 周几几点更 / 最新一话」。
2) 腾讯视频、优酷：抓取公开频道页，尽力解析其中可见的剧名与「更新至N集」
   「每周X更新」等文案；若页面改版或字段不可见，自动降级为种子表，
   **不做接口签名破解、不绕过风控、不抓取他人登录态数据**。
3) 输出统一 JSON + 一份离线可打开的按星期日历 HTML。
4) **封面图卡一起抓**：B站接口 / 腾讯公开页里每部剧的封面 URL 随条目抽出，
   HTML 卡片直接渲染海报；加 --download-covers 还能把图落盘到 covers/，
   日历改用本地图片，断网也能看图。图片下载失败只降级、不影响文字日历。
   自定义种子表可加 "cover": "https://..." 为兜底条目补图（见 seeds.example.json）。
   封面只对进入日历的条目抓取：星期未知已丢弃的条目不会产生任何图片请求。
5) --seed-only 完全离线运行，不联网也能出日历。

行为约定（重要）
----------------
- **星期未知的条目一律不抓取、不进入结果、不设「待核对」栏**。
  公开页解析、接口返回、自定义兜底表，只要拿不到明确的周一~周日，
  就在合并后直接丢弃；被丢弃的片名与数量会记进 JSON 的
  dropped_unknown_weekday 字段和运行说明，方便你核对漏了什么。
- 实时记录本身没星期、但兜底表有的，会先用兜底表补全再判断；
  补完仍无星期的才丢弃。

不能做什么（重要）
------------------
- 「我的追番」是登录态个人数据，只能查自己的账号。B站提供可选开关
  --bili-cookie + --bili-vmid；腾讯/优酷的个人追番未实现。
- 腾讯/优酷没有稳定公开的「在更列表」接口，页面由前端异步渲染，
  本脚本只解析公开可见内容，结果可能滞后或不完整，请核对平台原文。
- 「实时」= 每次运行拉一次，不是推送。要定时请自行配 cron / 计划任务，
  并遵守平台服务条款与 robots，保持低频（默认每请求间隔 1.5 秒）。

用法
----
  python3 guoman_tracker.py --seed-only                 # 离线看日历
  python3 guoman_tracker.py                            # 联网拉取（本机运行）
  python3 guoman_tracker.py --platforms bilibili       # 只跑 B站
  python3 guoman_tracker.py --download-covers          # 连封面一起下载到本地
  python3 guoman_tracker.py --seed-file my_seeds.json  # 用自己维护的兜底表
  python3 guoman_tracker.py --bili-cookie 'SESSDATA=...' --bili-vmid 123456

仅依赖 Python 3.8+ 标准库，无需 pip install。
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

WEEK_CN = {1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五", 6: "周六", 7: "周日"}
CN2NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7,
          "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7}


# --------------------------------------------------------------------------- #
# 数据模型
# --------------------------------------------------------------------------- #
@dataclass
class Show:
    platform: str            # bilibili / tencent / youku
    title: str
    weekday: int | None = None      # 1=周一 ... 7=周日
    pub_time: str = ""              # 如 "11:00"
    rule: str = ""                  # 更新规则原文
    latest: str = ""                # 如 "更新至162集"
    status: str = "在更"             # 在更 / 连载中 / 未知
    source: str = "seed"            # live(接口实时) / page(公开页解析) / seed(人工兜底)
    source_url: str = ""
    season_id: str = ""
    cover: str = ""              # 平台原始封面 URL
    cover_file: str = ""         # --download-covers 落盘后的相对路径
    note: str = ""
    fetched_at: str = ""
    raw: dict = field(default_factory=dict)

    def key(self) -> str:
        """宽松归一化，让「第二季 / 第2季」这类写法能合并成同一部。"""
        t = re.sub(r"[\s·:：\-—_（）()]+", "", self.title).lower()
        cn = {"一": "1", "二": "2", "三": "3", "四": "4", "五": "5",
              "六": "6", "七": "7", "八": "8", "九": "9", "十": "10"}
        t = re.sub(r"第([一二三四五六七八九十])季",
                   lambda m: f"第{cn.get(m.group(1), m.group(1))}季", t)
        t = t.replace("最终季", "第final季")
        return f"{self.platform}|{t}"


# --------------------------------------------------------------------------- #
# 内置兜底表：来自公开整理的「国漫更新日历」快照，非实时，仅作降级/离线示例。
# 请以平台实际页面为准，建议复制为 my_seeds.json 自行维护。
# --------------------------------------------------------------------------- #
SEED_SHOWS: list[dict] = [
    dict(platform="bilibili", title="凡人修仙传", weekday=6, pub_time="11:00", rule="每周六 11:00", note="年番"),
    dict(platform="bilibili", title="牧神记", weekday=7, pub_time="11:00", rule="每周日 11:00", note="年番"),
    dict(platform="bilibili", title="时光代理人 第三季", weekday=5, pub_time="11:00", rule="每周五 11:00"),
    dict(platform="tencent", title="仙逆", weekday=1, pub_time="10:00", rule="VIP 周一10:00 / SVIP 周日18:00"),
    dict(platform="tencent", title="吞噬星空", weekday=2, pub_time="10:00", rule="每周二 10:00"),
    dict(platform="tencent", title="遮天", weekday=3, pub_time="10:00", rule="每周三 10:00"),
    dict(platform="tencent", title="斩神之凡尘神域 第二季", weekday=4, pub_time="10:00", rule="每周四 10:00"),
    dict(platform="tencent", title="完美世界", weekday=5, pub_time="10:00", rule="每周五 10:00"),
    dict(platform="tencent", title="诛仙 最终季", weekday=5, pub_time="10:00", rule="每周五 10:00"),
    dict(platform="tencent", title="斗罗大陆Ⅱ绝世唐门", weekday=6, pub_time="10:00", rule="每周六 10:00"),
    dict(platform="tencent", title="斗破苍穹 年番", weekday=7, pub_time="10:00", rule="每周日 10:00"),
    dict(platform="youku", title="一斩苍穹", weekday=2, pub_time="10:00", rule="周二 10:00"),
    dict(platform="youku", title="师兄啊师兄", weekday=3, pub_time="10:00", rule="SVIP 周三 / VIP 次日"),
    dict(platform="youku", title="沧元图 第三季", weekday=5, pub_time="10:00", rule="SVIP 周五 / VIP 次日"),
    dict(platform="youku", title="光阴之外 第二季", weekday=6, pub_time="10:00", rule="SVIP 周六 / VIP 次日"),
]


# --------------------------------------------------------------------------- #
# HTTP（低频、串行、失败不崩）
# --------------------------------------------------------------------------- #
class Fetcher:
    def __init__(self, delay: float = 1.5, timeout: float = 15.0, retries: int = 2):
        self.delay = delay
        self.timeout = timeout
        self.retries = retries
        self._last = 0.0
        self.errors: list[str] = []
        self.skipped: list[Show] = []  # 解析层因星期未知跳过的条目留痕

    def _raw(self, url: str, referer: str = "", cookie: str = "",
             label: str = "") -> bytes | None:
        """串行、低频、带重试的原始 GET；文本与图片共用这一套节流。"""
        for attempt in range(self.retries + 1):
            wait = self.delay - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            headers = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9",
                       "Accept-Encoding": "gzip, deflate"}
            if referer:
                headers["Referer"] = referer
            if cookie:
                headers["Cookie"] = cookie
            req = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    data = resp.read()
                    if resp.headers.get("Content-Encoding") == "gzip":
                        data = gzip.decompress(data)
                    return data
            except Exception as exc:  # noqa: BLE001 - 逐平台降级，不让单点失败中断
                if attempt == self.retries:
                    host = urllib.parse.urlsplit(url).netloc
                    self.errors.append(f"{label or host}: {type(exc).__name__}: {exc}")
                    return None
                time.sleep(self.delay * (attempt + 1))
        return None

    def get(self, url: str, referer: str = "", cookie: str = "") -> str | None:
        data = self._raw(url, referer, cookie)
        return data.decode("utf-8", errors="ignore") if data is not None else None

    def get_bytes(self, url: str, referer: str = "", label: str = "") -> bytes | None:
        return self._raw(url, referer, label=label)

    def get_json(self, url: str, **kw) -> dict | None:
        text = self.get(url, **kw)
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            self.errors.append(f"JSON 解析失败: {url[:90]}")
            return None


def now_str() -> str:
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S CST")


WEEK_PATTERNS = [
    # 明确的「每周X / VIP…每周X」；日历导航条里的「周一 周二」不带「每」，不会误命中
    r"每\s*周\s*([一二三四五六日天1-7])",
    # 「周X 10:00 更新」「周X10点更1集」「周X更新」
    r"周\s*([一二三四五六日天1-7])\s*(?:\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点)?\s*"
    r"(?:更新|上线|更|开播|播出|放送)",
]


def parse_rule(text: str) -> tuple[int | None, str, str, str]:
    """从公开文案抽 (星期, 时间, 最新集数, 规则片段)。

    只认「带更新语义」的星期表达：抽不到就返回 None，由调用方直接丢弃，
    避免把日历导航条里的「周一 周二 周三」误判成某部剧的播出日。
    """
    if not text:
        return None, "", "", ""
    weekday, hint = None, ""
    for pat in WEEK_PATTERNS:
        m = re.search(pat, text)
        if m:
            weekday = CN2NUM.get(m.group(1))
            hint = text[max(0, m.start() - 16): min(len(text), m.end() + 36)].strip(" ,，{}:\"'")
            break
    tm = re.search(r"(\d{1,2}[:：]\d{2})", text)
    if tm:
        pub_time = tm.group(1).replace("：", ":")
    else:
        tm2 = re.search(r"(\d{1,2})\s*点", text)
        pub_time = f"{int(tm2.group(1)):02d}:00" if tm2 else ""
    ep = re.search(r"更新至\s*(\d+)\s*[集话期]", text)
    latest = f"更新至{ep.group(1)}集" if ep else ""
    return weekday, pub_time, latest, hint


# --------------------------------------------------------------------------- #
# 封面图卡
# --------------------------------------------------------------------------- #
def normalize_cover(url: str) -> str:
    """清洗封面 URL：去转义、http→https、丢掉明显不是图片的链接。"""
    if not url:
        return ""
    url = html.unescape(url.strip().strip('"\''))
    url = url.replace("\\u002F", "/").replace("\\/", "/")
    if url.startswith("//"):
        url = "https:" + url
    elif url.startswith("http://") and ("hdslb.com" in url or "qpic.cn" in url):
        # 平台图床统一升 https，避免混合内容被浏览器拦
        url = "https://" + url[7:]
    if not (url.startswith("https://") or url.startswith("http://")):
        return ""
    return url


COVER_PATTERNS = [
    # 腾讯竖版海报（优先，最接近剧集海报比例）
    r'smallCoverPic\s*:\s*"([^"]+)"',
    # 腾讯横版剧照
    r'coverPic\s*:\s*"([^"]+)"',
    # 通用 JSON 卡片字段
    r'"(?:cover|image|poster|pic)"\s*:\s*"([^"]+)"',
]


def extract_cover(ctx: str) -> str:
    """从剧集卡片上下文抽封面；取离锚点最近的一张，避免串到上一张卡片。"""
    for pat in COVER_PATTERNS:
        hits = re.findall(pat, ctx)
        if hits:
            url = normalize_cover(hits[-1])
            if url:
                return url
    return ""


def cover_ext(url: str, content_type: str = "") -> str:
    ct = (content_type or "").lower()
    if "png" in ct or ".png" in url.lower():
        return ".png"
    if "webp" in ct or ".webp" in url.lower():
        return ".webp"
    if "gif" in ct:
        return ".gif"
    return ".jpg"


def download_covers(shows: list[Show], out_dir: str, covers_dir: str,
                    fetcher: Fetcher, errors: list[str]) -> int:
    """只为进入日历的条目下载封面（星期未知的已被丢弃，不产生图片请求）。"""
    targets = [s for s in shows if normalize_cover(s.cover)]
    if not targets:
        errors.append("封面下载：无可用封面 URL，跳过（HTML 仍会尝试外链显示）")
        return 0
    abs_dir = os.path.join(out_dir, covers_dir)
    os.makedirs(abs_dir, exist_ok=True)
    ok = 0
    n_before = len(fetcher.errors)
    for s in targets:
        url = normalize_cover(s.cover)
        data = fetcher.get_bytes(url, label=f"封面 {s.platform}·{s.title}")
        if not data or len(data) < 1024:
            continue
        # 平台偶尔返回 JSON 错误体伪装成图片，简单挡一下
        if data[:1] in (b"{", b"[") or data[:5] == b"<?xml":
            continue
        ext = cover_ext(url)
        name = hashlib.md5(url.encode("utf-8")).hexdigest()[:16] + ext
        with open(os.path.join(abs_dir, name), "wb") as fp:
            fp.write(data)
        s.cover_file = f"{covers_dir}/{name}"
        ok += 1
    # 逐张的 403/超时不刷屏，只汇成一条；失败时 HTML 仍保留外链
    del fetcher.errors[n_before:]
    errors.append(f"封面下载：成功 {ok}/{len(targets)} 张，目录 {abs_dir}"
                  + (f"；失败 {len(targets) - ok} 张（多为图片 CDN 防盗链或网络策略），HTML 保留外链"
                     if ok < len(targets) else ""))
    return ok


def show_from_seed(d: dict) -> Show:
    return Show(
        platform=d.get("platform", ""), title=d.get("title", ""),
        weekday=d.get("weekday"), pub_time=d.get("pub_time", ""),
        rule=d.get("rule", ""), latest=d.get("latest", ""),
        status=d.get("status", "在更"), source="seed",
        source_url=d.get("source_url", ""),
        cover=normalize_cover(d.get("cover", "")),
        cover_file=d.get("cover_file", ""),
        note=d.get("note", "人工维护快照，非实时"),
        fetched_at=now_str(),
    )


# --------------------------------------------------------------------------- #
# B站：公开游客接口
# --------------------------------------------------------------------------- #
class BiliProvider:
    name = "bilibili"
    index_api = "https://api.bilibili.com/pgc/season/index/result"
    timeline_api = "https://api.bilibili.com/pgc/web/timeline"
    follow_api = "https://api.bilibili.com/x/space/bangumi/follow/list"

    def __init__(self, fetcher: Fetcher, cookie: str = "", vmid: str = ""):
        self.f = fetcher
        self.cookie = cookie
        self.vmid = vmid

    def fetch(self) -> list[Show]:
        shows: dict[str, Show] = {}
        referer = "https://www.bilibili.com/"

        # 1) 放送时间表：最贴合「按星期看哪天更」
        q = urllib.parse.urlencode({"types": 4, "before": 6, "after": 6})
        tl = self.f.get_json(f"{self.timeline_api}?{q}", referer=referer)
        if tl and tl.get("code") == 0:
            for day in tl.get("result") or []:
                wd = day.get("day_of_week")
                for ep in day.get("episodes") or []:
                    title = (ep.get("title") or "").strip()
                    if not title:
                        continue
                    pub_time = (ep.get("pub_time") or "")[:5]
                    s = Show(
                        platform=self.name, title=title,
                        weekday=wd if wd in WEEK_CN else None,
                        pub_time=pub_time,
                        rule=f"{WEEK_CN.get(wd, '')} {pub_time}" if wd in WEEK_CN else "",
                        latest=ep.get("pub_index", "") or "",
                        status="在更", source="live",
                        source_url=f"https://www.bilibili.com/bangumi/play/ss{ep.get('season_id', '')}",
                        season_id=str(ep.get("season_id", "") or ""),
                        cover=ep.get("square_cover") or ep.get("cover") or "",
                        note=ep.get("delay_reason", "") or "",
                        fetched_at=now_str(),
                        raw={"published": ep.get("published"), "delay": ep.get("delay")},
                    )
                    shows[s.key()] = s
        else:
            self.f.errors.append("bilibili: 时间表接口未返回可用数据（可能被网络策略拦截或接口调整）")

        # 2) 国创「连载中」索引：补 state / 最新集 / 追番人数等
        params = {
            "season_type": 4,   # 4=国创
            "type": 1,
            "is_finish": 0,     # 0=连载
            "order": 0,         # 0=按更新时间
            "sort": 0,
            "st": 4,
            "page": 1,
            "pagesize": 50,
        }
        idx = self.f.get_json(f"{self.index_api}?{urllib.parse.urlencode(params)}", referer=referer)
        if idx and idx.get("code") == 0:
            for it in (idx.get("data") or {}).get("list") or []:
                title = (it.get("title") or "").strip()
                if not title:
                    continue
                s = shows.get(Show(platform=self.name, title=title).key())
                if s is None:
                    s = Show(platform=self.name, title=title, source="live",
                             status="连载中", fetched_at=now_str(),
                             source_url=f"https://www.bilibili.com/bangumi/play/ss{it.get('season_id','')}")
                    shows[s.key()] = s
                # 字段名以平台实测为准，这里逐个宽容取值，取不到就留空
                s.latest = s.latest or (it.get("index_show") or it.get("pub_index") or "")
                s.cover = s.cover or (it.get("cover") or "")
                s.season_id = s.season_id or str(it.get("season_id") or "")
                s.status = "连载中"
                s.raw.update({"score": it.get("score"), "order": it.get("order")})
        else:
            self.f.errors.append("bilibili: 国创连载索引未返回可用数据")

        # 3) 可选：只查「自己」的追番（需自备 Cookie + 自己的 vmid）
        if self.cookie and self.vmid:
            fq = urllib.parse.urlencode({"vmid": self.vmid, "type": 1, "pn": 1, "ps": 30})
            fj = self.f.get_json(f"{self.follow_api}?{fq}", referer=referer, cookie=self.cookie)
            if fj and fj.get("code") == 0:
                for it in ((fj.get("data") or {}).get("list") or []):
                    title = (it.get("title") or "").strip()
                    if not title:
                        continue
                    k = Show(platform=self.name, title=title).key()
                    s = shows.get(k)
                    if s is None:
                        s = Show(platform=self.name, title=title, source="live",
                                 status="追番中", fetched_at=now_str())
                        shows[k] = s
                    s.cover = s.cover or normalize_cover(it.get("cover") or "")
                    s.note = (s.note + " / 我的追番").strip(" /")
            else:
                self.f.errors.append("bilibili: 我的追番未取到（Cookie 可能失效）")

        return list(shows.values())


# --------------------------------------------------------------------------- #
# 腾讯视频 / 优酷：只解析公开频道页可见内容，不碰私有签名接口
# --------------------------------------------------------------------------- #
class PageProvider:
    """通用公开页解析器：抽剧名 + 「更新至N集」+「每周X更新」文案。"""
    def __init__(self, name: str, url: str, fetcher: Fetcher,
                 title_patterns: list[str], tail: str):
        self.name = name
        self.url = url
        self.f = fetcher
        self.title_patterns = title_patterns
        self.tail = tail

    def fetch(self) -> list[Show]:
        text = self.f.get(self.url, referer=self.url)
        if not text:
            self.f.errors.append(f"{self.name}: 频道页不可达，降级为种子表")
            return []

        found: dict[str, Show] = {}
        skipped_no_weekday = 0
        # 页面里形如 mzTitle:"仙逆" / "title":"xxx" 的卡片字段
        for pat in self.title_patterns:
            for m in re.finditer(pat, text):
                title = (m.group(1) or "").strip()
                title = html.unescape(title)
                if not (2 <= len(title) <= 30) or not re.search(r"[\u4e00-\u9fa5A-Za-z]", title):
                    continue
                # 更新文案用窄窗口，避免把上一张卡片的「每周」串进来
                rule_ctx = text[max(0, m.start() - 200): m.end() + 600]
                wd, tm, latest, hint = parse_rule(rule_ctx)
                # 拿不到明确星期 → 按要求不抓取，也不进「星期未知」区
                if wd not in WEEK_CN:
                    skipped_no_weekday += 1
                    self.f.skipped.append(Show(platform=self.name, title=title, source="page"))
                    continue
                # 封面往往在剧名字段前 400~800 字，单独用宽窗口抽，取最近的一张
                cover_ctx = text[max(0, m.start() - 1200): m.end() + 200]
                cover = extract_cover(cover_ctx)
                s = Show(platform=self.name, title=title,
                         weekday=wd, pub_time=tm, latest=latest,
                         rule=hint[:120],
                         status="在更",
                         source="page", source_url=self.url,
                         cover=cover,
                         note="公开页解析，字段可能滞后，请核对平台原文",
                         fetched_at=now_str())
                found.setdefault(s.key(), s)

        if not found:
            self.f.errors.append(
                f"{self.name}: 公开页未解析出带星期的剧集卡片"
                f"（{skipped_no_weekday} 条无明确星期已跳过，或字段前端异步渲染），降级为种子表")
        else:
            self.f.errors.append(
                f"{self.name}: 公开页保留 {len(found)} 部；"
                f"{skipped_no_weekday} 条星期未知已跳过")
        return list(found.values())


def build_tencent(f: Fetcher) -> PageProvider:
    url = ("https://v.qq.com/channel/cartoon?channel_2022=1&istate=2"
           "&itype=4&iarea=16&offset=0&sort=19")
    return PageProvider("tencent", url, f,
                        title_patterns=[r'mzTitle\s*:\s*"([^"]+)"',
                                        r'"title"\s*:\s*"([^"]{2,30})"'],
                        tail="v.qq.com")


def build_youku(f: Fetcher) -> PageProvider:
    url = "https://youku.com/channel/webcomic/list"
    return PageProvider("youku", url, f,
                        title_patterns=[r'"title"\s*:\s*"([^"]{2,30})"',
                                        r'name\s*:\s*"([^"]{2,30})"'],
                        tail="youku.com")


# --------------------------------------------------------------------------- #
# 合并 / 输出
# --------------------------------------------------------------------------- #
PLATFORM_CN = {"bilibili": "B站国创", "tencent": "腾讯视频", "youku": "优酷动漫"}
SOURCE_CN = {"live": "接口实时", "page": "公开页解析", "seed": "人工快照"}


def merge(live: list[Show], seeds: list[Show]) -> tuple[list[Show], list[Show]]:
    out = {s.key(): s for s in live}
    for s in seeds:
        k = s.key()
        if k not in out:
            out[k] = s
        else:
            # 实时记录缺星期时，用种子表补全（补全处标记为混合来源）
            cur = out[k]
            if cur.weekday is None and s.weekday is not None:
                cur.weekday, cur.pub_time, cur.rule = s.weekday, s.pub_time, s.rule
                cur.note = (cur.note + " / 星期由人工快照补全").strip(" /")
            if not cur.latest and s.latest:
                cur.latest = s.latest
            if not cur.cover and s.cover:
                cur.cover = s.cover
            if not cur.cover_file and s.cover_file:
                cur.cover_file = s.cover_file
    # 星期未知的一律不进入结果（不做「待核对」栏），但返回给调用方用于留痕
    kept = [s for s in out.values() if s.weekday in WEEK_CN]
    dropped = [s for s in out.values() if s.weekday not in WEEK_CN]
    kept.sort(key=lambda x: (x.weekday, PLATFORM_CN.get(x.platform, x.platform), x.title))
    dropped.sort(key=lambda x: (x.platform, x.title))
    return kept, dropped


def write_json(shows: list[Show], errors: list[str], path: str,
               dropped_titles: list[str] | None = None) -> None:
    dropped_titles = dropped_titles or []
    payload = {
        "generated_at": now_str(),
        "disclaimer": "B站为公开接口实时数据；腾讯/优酷为公开页尽力解析；seed 为人工快照非实时。"
                      "星期未知的条目一律不抓取。请以平台原文为准。",
        "counts": {"total": len(shows),
                   "by_source": {k: sum(1 for s in shows if s.source == k) for k in SOURCE_CN},
                   "by_platform": {k: sum(1 for s in shows if s.platform == k) for k in PLATFORM_CN},
                   "with_cover": sum(1 for s in shows if normalize_cover(s.cover)),
                   "covers_downloaded": sum(1 for s in shows if s.cover_file)},
        "dropped_unknown_weekday": {
            "count": len(dropped_titles),
            "note": "最终未进入日历的星期未知条目；已被兜底表补全星期的同名剧不计入。",
            "titles": dropped_titles,
        },
        "errors": errors,
        "shows": [asdict(s) for s in shows],
    }
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)


def write_html(shows: list[Show], errors: list[str], path: str) -> None:
    css = """
    *{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;
    font-family:"WenQuanYi Micro Hei","PingFang SC","Microsoft YaHei",sans-serif}
    header{padding:28px 32px 8px}h1{margin:0;font-size:24px;letter-spacing:1px}
    .sub{color:#8b949e;font-size:13px;margin-top:8px;line-height:1.7}
    .wrap{display:grid;grid-template-columns:repeat(7,minmax(150px,1fr));gap:10px;padding:16px 24px 40px}
    .col{background:#161b22;border:1px solid #30363d;border-radius:10px;min-height:120px}
    .col h2{font-size:14px;margin:0;padding:12px;border-bottom:1px solid #30363d;color:#79c0ff}
    .col.today h2{color:#ffd33d;border-bottom-color:#ffd33d}
    .card{margin:10px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:8px;
    font-size:13px;display:flex;gap:9px;align-items:flex-start}
    .cover{width:54px;height:74px;object-fit:cover;border-radius:5px;flex:0 0 auto;background:#21262d}
    .body{min-width:0;flex:1}
    .card .t{font-weight:600;line-height:1.4;margin-bottom:6px;overflow-wrap:anywhere}
    .tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;margin-right:4px;vertical-align:middle}
    .b{background:#1f6feb33;color:#79c0ff}.t{background:#fb729933;color:#ff9db0}.y{background:#1f9c5533;color:#7ee787}
    .s-live{background:#238636;color:#fff}.s-page{background:#9e6a03;color:#fff}.s-seed{background:#484f58;color:#c9d1d9}
    .meta{color:#8b949e;font-size:11px;line-height:1.6;margin-top:5px}
    .err{margin:0 24px 20px;padding:12px;background:#2d1618;border:1px solid #6e2c30;border-radius:8px;
    color:#ffa198;font-size:12px;line-height:1.8}
    @media(max-width:1100px){.wrap{grid-template-columns:repeat(2,1fr)}}
    """
    today = datetime.now(CST).isoweekday()
    cols = []
    for wd in range(1, 8):
        items = [s for s in shows if s.weekday == wd]
        cards = []
        for s in items:
            pc = PLATFORM_CN.get(s.platform, s.platform)
            pcls = {"bilibili": "b", "tencent": "t", "youku": "y"}.get(s.platform, "b")
            bits = []
            if s.latest:
                bits.append(html.escape(s.latest))
            if s.pub_time:
                bits.append(html.escape(s.pub_time))
            if s.rule and s.rule not in bits:
                bits.append(html.escape(s.rule[:40]))
            # 本地图优先；没有就外链平台 CDN，加载失败时静默隐藏，不影响文字
            img_src = s.cover_file or normalize_cover(s.cover)
            img = ""
            if img_src:
                img = (f'<img class="cover" src="{html.escape(img_src, quote=True)}" '
                       f'alt="{html.escape(s.title, quote=True)} 封面" loading="lazy" '
                       f'referrerpolicy="no-referrer" onerror="this.hidden=true">')
            cards.append(
                f'<div class="card">{img}<div class="body">'
                f'<div><span class="tag {pcls}">{html.escape(pc)}</span>'
                f'<span class="tag s-{s.source}">{SOURCE_CN.get(s.source, s.source)}</span></div>'
                f'<div class="t">{html.escape(s.title)}</div>'
                f'<div class="meta">{" · ".join(bits) or html.escape(s.status)}<br>'
                f'{html.escape(s.note or "")}</div></div></div>'
            )
        cls = "col today" if wd == today else "col"
        cols.append(f'<div class="{cls}"><h2>{WEEK_CN[wd]} · {len(items)} 部'
                    + (" · 今天" if wd == today else "") + "</h2>"
                    + ("".join(cards) or '<div class="meta" style="padding:12px">暂无记录</div>')
                    + "</div>")
    err_html = ""
    if errors:
        err_html = ('<div class="err"><b>运行说明 / 降级提示</b><br>'
                    + "<br>".join(html.escape(e) for e in errors) + "</div>")
    doc = (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
           f'<meta name="viewport" content="width=device-width,initial-scale=1">'
           f'<title>国漫在更日历</title><style>{css}</style></head><body>'
           f'<header><h1>国漫在更 · 放送日历</h1>'
           f'<div class="sub">生成于 {now_str()} ｜ 共 {len(shows)} 部 ｜ '
           f'带封面 {sum(1 for s in shows if normalize_cover(s.cover))} 部'
           f'（本地图 {sum(1 for s in shows if s.cover_file)} 张）｜ '
           f'B站=公开接口实时 · 腾讯/优酷=公开页尽力解析 · 灰标=人工快照（非实时）<br>'
           f'星期未知条目已过滤、不抓取，也不单列；封面加载失败会自动隐藏；'
           f'「实时」指每次运行拉取一次，不是自动推送；请以各平台页面为准。</div></header>'
           f'{err_html}<div class="wrap">' + "".join(cols) + "</div></body></html>")
    with open(path, "w", encoding="utf-8") as fp:
        fp.write(doc)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def load_seeds(path: str | None) -> list[Show]:
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as fp:
            data = json.load(fp)
        return [show_from_seed(d) for d in data]
    return [show_from_seed(d) for d in SEED_SHOWS]


def main() -> int:
    ap = argparse.ArgumentParser(description="国漫在更/放送日历聚合器")
    ap.add_argument("--platforms", default="bilibili,tencent,youku",
                    help="逗号分隔：bilibili,tencent,youku")
    ap.add_argument("--seed-only", action="store_true", help="完全离线，只用兜底表生成日历")
    ap.add_argument("--seed-file", default="", help="自定义兜底表 JSON（数组）")
    ap.add_argument("--out-dir", default=".", help="输出目录")
    ap.add_argument("--json-name", default="guoman_now.json")
    ap.add_argument("--html-name", default="guoman_calendar.html")
    ap.add_argument("--download-covers", action="store_true",
                    help="把封面下载到 --covers-dir，日历改用本地图片（失败则保留外链）")
    ap.add_argument("--covers-dir", default="covers", help="封面落盘子目录，默认 covers/")
    ap.add_argument("--delay", type=float, default=1.5, help="每请求最小间隔秒数，默认 1.5（图片下载同样生效）")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--bili-cookie", default="", help="仅用于读取「我自己的」追番，可选")
    ap.add_argument("--bili-vmid", default="", help="自己的 B站 UID，配合 --bili-cookie")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    seeds = load_seeds(args.seed_file or None)
    platform_list = [p.strip() for p in args.platforms.split(",") if p.strip()]

    live: list[Show] = []
    errors: list[str] = []
    f = Fetcher(delay=args.delay, timeout=args.timeout)  # 文本/图片共用同一套低频节流
    if not args.seed_only:
        providers = {
            "bilibili": lambda: BiliProvider(f, args.bili_cookie, args.bili_vmid).fetch(),
            "tencent": lambda: build_tencent(f).fetch(),
            "youku": lambda: build_youku(f).fetch(),
        }
        for p in platform_list:
            if p not in providers:
                errors.append(f"未知平台: {p}")
                continue
            print(f"[..] 拉取 {PLATFORM_CN.get(p, p)} ...", flush=True)
            try:
                got = providers[p]()
                print(f"[ok] {PLATFORM_CN.get(p, p)}: {len(got)} 条", flush=True)
                live.extend(got)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{p}: {type(exc).__name__}: {exc}")
                print(f"[!!] {p} 失败，降级为种子表", flush=True)
        errors.extend(f.errors)
        if not errors:
            errors.append("无降级；所有平台均按预期返回（仍建议核对腾讯/优酷原文）")
    else:
        errors.append("离线模式：未联网，全部为人工快照，非实时数据")

    shows, dropped = merge(live, [s for s in seeds if s.platform in platform_list])
    for s in shows:                       # 统一清洗所有来源的封面 URL
        s.cover = normalize_cover(s.cover)
    kept_keys = {s.key() for s in shows}
    # 解析层跳过的条目，若已被兜底表补全星期并进入日历，就不算「未抓取」
    net_dropped: dict[str, Show] = {s.key(): s for s in dropped}
    for s in (f.skipped if not args.seed_only else []):
        if s.key() not in kept_keys:
            net_dropped.setdefault(s.key(), s)
    dropped_titles = [f"{PLATFORM_CN.get(s.platform, s.platform)} · {s.title}"
                      for s in sorted(net_dropped.values(), key=lambda x: (x.platform, x.title))]
    if dropped_titles:
        errors.append(f"星期未知共 {len(dropped_titles)} 部，按要求不抓取："
                      + "、".join(dropped_titles[:12])
                      + ("…" if len(dropped_titles) > 12 else ""))
    else:
        errors.append("星期未知条目：0 部，无需过滤")
    if args.download_covers:
        print("[..] 下载封面图卡 ...", flush=True)
        download_covers(shows, args.out_dir, args.covers_dir, f, errors)
    else:
        errors.append("封面：已随条目抽出 URL 并在 HTML 外链显示；加 --download-covers 可落盘到本地")

    jp = os.path.join(args.out_dir, args.json_name)
    hp = os.path.join(args.out_dir, args.html_name)
    write_json(shows, errors, jp, dropped_titles)
    write_html(shows, errors, hp)

    n_cover = sum(1 for s in shows if s.cover)
    n_local = sum(1 for s in shows if s.cover_file)
    print(f"\n共 {len(shows)} 部 | "
          + " / ".join(f"{k}:{v}" for k, v in
                      {kk: sum(1 for s in shows if s.source == kk) for kk in SOURCE_CN}.items())
          + f" | 封面 {n_cover} 张（本地 {n_local}）"
          + f" | 未抓取星期未知 {len(dropped_titles)} 部")
    print(f"JSON -> {jp}\nHTML -> {hp}")
    for e in errors:
        print("  ! " + e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
