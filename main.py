import asyncio
import os
import sys
import json
import time
import uuid
from typing import Optional, Dict, Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx

# Add server and all package subdirectories to Python path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(BASE_DIR, "server")

for search_path in [
    BASE_DIR,
    SERVER_DIR,
    os.path.join(SERVER_DIR, "portal"),
    os.path.join(SERVER_DIR, "academia"),
    os.path.join(SERVER_DIR, "academia", "core"),
    os.path.join(SERVER_DIR, "academia", "services")
]:
    if search_path not in sys.path:
        sys.path.insert(0, search_path)

from portal_client import PortalSession, PortalClient
from portal_attendance_service import PortalAttendanceService
from portal_timetable_service import PortalTimetableService
from portal_profile_service import PortalProfileService

from academia_client import AcademiaClient
from course_service import CourseService
from timetable_service import TimetableService
from profile_service import ProfileService

app = FastAPI(
    title="Corespace Server",
    description="Corespace Unified API for SRMIST Student Portal and Academia",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session cache for portal captchas (keyed by session_id)
SESSION_STORE: Dict[str, Dict[str, Any]] = {}
SESSION_TTL_SECONDS = 600  # 10 minutes

def clean_expired_sessions():
    now = time.time()
    expired = [k for k, v in SESSION_STORE.items() if now - v.get("timestamp", 0) > SESSION_TTL_SECONDS]
    for k in expired:
        SESSION_STORE.pop(k, None)

async def check_academia_exists(email: str) -> bool:
    """Checks whether the user email exists on Academia (Zoho Accounts)."""
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
            "Origin": "https://academia.srmist.edu.in",
            "Referer": "https://academia.srmist.edu.in/"
        }
        async with httpx.AsyncClient(headers=headers, timeout=5.0) as client:
            r = await client.get("https://academia.srmist.edu.in/accounts/p/10002227248/signin?hide_fp=true&orgtype=40&service_language=en&css_url=/49910842/academia-academic-services/downloadPortalCustomCss/login&dcc=true")
            csrf = client.cookies.get("iamcsr")
            if not csrf:
                return False
            url = f"https://academia.srmist.edu.in/accounts/p/40-10002227248/signin/v2/lookup/{email}"
            res = await client.post(url, headers={"X-ZCSRF-TOKEN": f"iamcsrcoo={csrf}"})
            data = res.json()
            if data.get("status_code") == 400:
                for err in data.get("errors", []):
                    if err.get("code") in ["U401", "U410"] or "does not exist" in err.get("message", "").lower():
                        return False
            return True
    except Exception:
        return False

class FetchRequest(BaseModel):
    portal_netid: str
    portal_password: str
    portal_captcha: str
    session_id: Optional[str] = None
    portal_cookies: Optional[Dict[str, str]] = None
    academia_password: Optional[str] = None

@app.get("/")
def root():
    return {
        "status": "healthy",
        "service": "Corespace Unified API",
        "endpoints": {
            "captcha": "/api/captcha",
            "fetch": "/api/fetch",
            "health": "/health",
            "docs": "/docs"
        }
    }

@app.get("/health")
def health():
    return {"status": "healthy"}

@app.get("/api/captcha")
async def get_captcha():
    clean_expired_sessions()
    p_session = PortalSession()
    try:
        captcha_data = await p_session.load_captcha()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to load captcha from Portal: {str(e)}")

    session_id = str(uuid.uuid4())
    cookies_dict = {c.name: c.value for c in p_session.client.cookies.jar}

    sess_state = {
        "timestamp": time.time(),
        "nonce": p_session.nonce,
        "domain_field_name": p_session.domain_field_name,
        "captcha_field_name": p_session.captcha_field_name,
        "random_delimiter": p_session.random_delimiter,
        "login_form_fields": p_session.login_form_fields,
        "load_ms": p_session.load_ms,
        "cookies": cookies_dict
    }

    SESSION_STORE[session_id] = sess_state

    # Also map by JSESSIONID if available
    jsessionid = cookies_dict.get("JSESSIONID")
    if jsessionid:
        SESSION_STORE[jsessionid] = sess_state

    return {
        "success": True,
        "session_id": session_id,
        "captcha_image": captcha_data.get("captcha_image"),
        "cookies": cookies_dict
    }

@app.post("/api/fetch")
async def fetch_all_data(req: FetchRequest):
    clean_expired_sessions()

    # 1. Retrieve the existing session data that requested the captcha
    sess_data = None
    if req.session_id and req.session_id in SESSION_STORE:
        sess_data = SESSION_STORE.pop(req.session_id, None)
    elif req.portal_cookies and "JSESSIONID" in req.portal_cookies and req.portal_cookies["JSESSIONID"] in SESSION_STORE:
        sess_data = SESSION_STORE.pop(req.portal_cookies["JSESSIONID"], None)

    p_session = PortalSession()
    if sess_data:
        p_session.nonce = sess_data.get("nonce")
        p_session.domain_field_name = sess_data.get("domain_field_name")
        p_session.captcha_field_name = sess_data.get("captcha_field_name")
        p_session.random_delimiter = sess_data.get("random_delimiter")
        p_session.login_form_fields = sess_data.get("login_form_fields") or {}
        p_session.load_ms = sess_data.get("load_ms")
        p_session.captcha_page = "loaded"
        if sess_data.get("cookies"):
            p_session.client.cookies.update(sess_data["cookies"])
    elif req.portal_cookies:
        p_session.client.cookies.update(req.portal_cookies)

    # 2. Login to Portal
    try:
        res = await p_session.login(req.portal_netid, req.portal_password, req.portal_captcha)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Portal login request error: {str(e)}")

    if not res.get("ok"):
        raise HTTPException(
            status_code=401,
            detail={
                "message": res.get("message", "Portal login failed"),
                "reason": res.get("reason", "login_failed")
            }
        )

    portal_client = PortalClient(res["cookies"])

    # 3. Check and Authenticate with Academia (if available and requested)
    acad_client = None
    email = f"{req.portal_netid}@srmist.edu.in" if "@" not in req.portal_netid else req.portal_netid
    is_acad_available = await check_academia_exists(email)

    if is_acad_available and req.academia_password and req.academia_password.strip():
        try:
            client = AcademiaClient(email, req.academia_password.strip())
            await client.authenticate()
            acad_client = client
        except Exception as e:
            print(f"Academia login failed: {e}", flush=True)

    # 4. Fetch Data Concurrently
    async def dummy(): return None
    acad_prof_task = acad_client.get_profile_html() if acad_client else dummy()
    acad_g1_task = acad_client.get_grid_html("Batch_1") if acad_client else dummy()
    acad_g2_task = acad_client.get_grid_html("batch_2") if acad_client else dummy()

    port_att_task = portal_client.get_attendance_html()
    port_marks_task = portal_client.get_marks_data()
    port_prof_task = portal_client.get_profile_html()
    port_tt_task = portal_client.get_timetable_html()

    (acad_prof, acad_g1, acad_g2, port_att, port_marks, port_prof, port_tt) = await asyncio.gather(
        acad_prof_task, acad_g1_task, acad_g2_task,
        port_att_task, port_marks_task, port_prof_task, port_tt_task,
        return_exceptions=True
    )

    if isinstance(acad_prof, Exception): acad_prof = None
    if isinstance(acad_g1, Exception): acad_g1 = None
    if isinstance(acad_g2, Exception): acad_g2 = None
    if isinstance(port_att, Exception): port_att = None
    if isinstance(port_marks, Exception): port_marks = None
    if isinstance(port_prof, Exception): port_prof = None
    if isinstance(port_tt, Exception): port_tt = None

    # 5. Parse Profile (Portal base + Academia enrichment)
    profile = {}
    if port_prof:
        try:
            profile = PortalProfileService.parse(port_prof)
        except Exception as e:
            print(f"Error parsing portal profile: {e}", flush=True)

    if acad_prof:
        try:
            ap = ProfileService.parse_student_profile(acad_prof)
            for key in ["section", "batch", "semester", "dept", "program", "name", "regNo", "mobile"]:
                val = ap.get(key)
                if val and val not in [None, "", "-", "N/A", "Unknown", "2"]:
                    profile[key] = val
        except Exception as e:
            print(f"Error parsing academia profile: {e}", flush=True)

    # 6. Parse Academia Courses & Timetable
    acad_course_map = {}
    acad_schedule = {}
    if acad_client and acad_prof:
        try:
            acad_course_map = CourseService.get_course_map(acad_prof)
            if acad_g1:
                acad_schedule = TimetableService.parse_unified_grid(acad_g1, acad_course_map)
            if not acad_schedule and acad_g2:
                acad_schedule = TimetableService.parse_unified_grid(acad_g2, acad_course_map)
        except Exception as e:
            print(f"Error parsing academia timetable: {e}", flush=True)

    # 7. Parse Portal Data
    attendance = []
    try:
        if port_att:
            attendance, _ = PortalAttendanceService.parse(port_att)
    except Exception as e:
        print(f"Error parsing portal attendance: {e}", flush=True)

    portal_schedule = {}
    try:
        if port_tt:
            portal_schedule, _ = PortalTimetableService.parse(port_tt)
    except Exception as e:
        print(f"Error parsing portal timetable: {e}", flush=True)

    # 8. Static Calendar
    cal_data = []
    try:
        cal_path = os.path.join(SERVER_DIR, "calendar_data.json")
        if not os.path.exists(cal_path):
            cal_path = os.path.join(BASE_DIR, "calendar_data.json")
        if os.path.exists(cal_path):
            with open(cal_path, "r", encoding="utf-8") as f:
                cal_data = json.load(f)
    except Exception as e:
        print(f"Error loading calendar_data.json: {e}", flush=True)

    return {
        "success": True,
        "is_academia_available": is_acad_available,
        "profile": profile,
        "courses": acad_course_map,
        "attendance": attendance,
        "marks": port_marks or [],
        "timetable": {
            "academia": acad_schedule,
            "portal": portal_schedule
        },
        "calendar": cal_data
    }

if __name__ == "__main__":
    import uvicorn
    raw_port = str(os.environ.get("PORT", "8000")).strip()
    try:
        port = int(raw_port)
    except (ValueError, TypeError):
        port = 8000
    print(f"[STARTUP] Starting Corespace server on 0.0.0.0:{port}...", flush=True)
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
