import asyncio
import base64
import json
import sys
import getpass
import os

# Add paths so we can import from both academia and portal folders
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), 'academia')))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), 'portal')))

from academia.core.academia_client import AcademiaClient
from academia.services.course_service import CourseService
from academia.services.timetable_service import TimetableService
from academia.services.profile_service import ProfileService

from portal.portal_client import PortalSession, PortalClient
from portal.portal_attendance_service import PortalAttendanceService
from portal.portal_timetable_service import PortalTimetableService
from portal.portal_profile_service import PortalProfileService
from portal.portal_marks_service import PortalMarksService
from portal.portal_calendar_service import CalendarService

async def login_academia(email, password):
    print("\n[+] Logging into Academia...")
    client = AcademiaClient(email, password)
    try:
        await client.authenticate()
    except Exception as e:
        err_str = str(e)
        try:
            err_data = json.loads(err_str)
            if err_data.get("type") == "CAPTCHA_REQUIRED":
                print(f"\n[!] Academia Captcha Required: {err_data.get('message')}")
                print(f"URL: {err_data.get('image')}")
                captcha_ans = input("Enter Academia Captcha: ")
                cdigest = err_data.get("cdigest")
                await client.authenticate(captcha_ans, cdigest)
        except json.JSONDecodeError:
            print(f"Academia Login failed: {err_str}")
            return None
    print("[+] Academia Login successful!")
    return client

async def login_portal(portal_id, password):
    print("\n[+] Loading Portal Captcha...")
    session = PortalSession()
    try:
        captcha_info = await session.load_captcha()
        b64_image = captcha_info.get("captcha_image")
        if b64_image and b64_image.startswith("data:image/png;base64,"):
            b64_data = b64_image.split(",")[1]
            with open("portal_captcha.png", "wb") as f:
                f.write(base64.b64decode(b64_data))
            print("[!] Portal Captcha saved as 'portal_captcha.png'.")
            captcha_ans = input("Enter Portal Captcha: ")
        else:
            captcha_ans = ""
            
        print("[+] Logging into Portal...")
        res = await session.login(portal_id, password, captcha_ans)
        if not res.get("ok"):
            print(f"Portal Login failed: {res.get('message')}")
            return None
            
        print("[+] Portal Login successful!")
        return PortalClient(res["cookies"])
    except Exception as e:
        print(f"Portal Error: {e}")
        return None

async def main():
    print("=== Corespace Unified Fetcher ===")
    portal_id = input("Portal NetID (e.g. hk9864 / 1000...): ")
    portal_pass = getpass.getpass("Portal Password: ")

    portal_client = await login_portal(portal_id, portal_pass)
    if not portal_client:
        sys.exit(1)

    # Infer academia email
    email = f"{portal_id}@srmist.edu.in"
    print(f"\nAcademia Email inferred as: {email}")
    acad_pass = getpass.getpass("Academia Password (leave blank if none): ")

    acad_client = None
    if acad_pass.strip():
        acad_client = await login_academia(email, acad_pass)
        if not acad_client:
            print("  -> Proceeding without Academia data...")

    print("\n[+] Fetching data concurrently...")
    
    # Define placeholder tasks that return None
    async def dummy_task(): return None
    
    acad_profile_task = acad_client.get_profile_html() if acad_client else dummy_task()
    acad_grid1_task = acad_client.get_grid_html("Batch_1") if acad_client else dummy_task()
    acad_grid2_task = acad_client.get_grid_html("batch_2") if acad_client else dummy_task()
    
    port_att_task = portal_client.get_attendance_html()
    port_marks_task = portal_client.get_marks_data()
    port_prof_task = portal_client.get_profile_html()
    port_tt_task = portal_client.get_timetable_html()
    port_cal_task = portal_client.get_calendar_html()

    (acad_prof_html, acad_g1, acad_g2, 
     port_att, port_marks, port_prof, port_tt, port_cal) = await asyncio.gather(
        acad_profile_task, acad_grid1_task, acad_grid2_task,
        port_att_task, port_marks_task, port_prof_task, port_tt_task, port_cal_task
    )

    print("\n" + "="*50)
    print("=== UNIFIED PROFILE ===")
    
    # Base profile from Portal
    profile = {}
    if port_prof:
        profile = PortalProfileService.parse(port_prof)
        
    # Enrich with Academia data
    acad_course_map = {}
    if acad_prof_html:
        acad_course_map = CourseService.get_course_map(acad_prof_html)
        acad_profile = ProfileService.parse_student_profile(acad_prof_html)
        
        # Merge academia profile fields into the portal profile if they exist and are valid
        for key in ['section', 'batch', 'semester', 'dept', 'program', 'name', 'regNo', 'mobile']:
            val = acad_profile.get(key)
            if val and val not in [None, '', '-', 'N/A', 'Unknown', '2']:
                profile[key] = val
            
    print(f"  Name:     {profile.get('name', 'N/A')}")
    print(f"  RegNo:    {profile.get('regNo', 'N/A')}")
    print(f"  Mobile:   {profile.get('mobile', 'N/A')}")
    print(f"  Batch:    {profile.get('batch', 'N/A')}")
    print(f"  Semester: {profile.get('semester', 'N/A')}")
    print(f"  Section:  {profile.get('section', 'N/A')}")
    print(f"  Program:  {profile.get('program', 'N/A')}")

    if acad_client:
        print("\n=== ACADEMIA COURSES ===")
        for slot, course in acad_course_map.items():
            print(f"  [{slot}] {course['code']} - {course['name']} ({course['type']})")

    if port_att:
        print("\n=== PORTAL ATTENDANCE ===")
        courses, _ = PortalAttendanceService.parse(port_att)
        for c in courses:
            print(f"  [{c['code']}] {c['title']} - {c['percent']}% ({c['present']}/{c['conducted']})")

    if port_marks:
        print("\n=== PORTAL MARKS ===")
        for m in port_marks:
            total = m.get('totalMarkGot', 'N/A')
            max_marks = m.get('totalMaxMarks', 'N/A')
            print(f"  [{m['courseCode']}] {m['title']} -> {total} / {max_marks}")
            if m.get('assessments'):
                for a in m['assessments']:
                    print(f"      - {a['title']}: {a['marks']}/{a['total']}")

    portal_schedule = None
    if port_tt:
        portal_schedule, _ = PortalTimetableService.parse(port_tt)

    print("\n=== PORTAL TIMETABLE ===")
    if portal_schedule:
        for day, slots in portal_schedule.items():
            print(f"\n  {day}:")
            for time, details in slots.items():
                print(f"    {time} -> {details['slot']} | {details['course']} ({details['room']})")
    else:
        print("  Could not parse portal timetable.")
        if port_tt:
            from bs4 import BeautifulSoup
            import textwrap
            soup = BeautifulSoup(port_tt, 'lxml')
            
            # Look for an alert message first
            alert = soup.find(class_=lambda c: c and 'alert' in c)
            if alert:
                msg = alert.get_text(separator=' ', strip=True)
            else:
                # Fallback to all body text
                msg = soup.get_text(separator=' ', strip=True)
                
            print(f"  Portal Output: {textwrap.shorten(msg, width=150, placeholder='...')}")
            
            with open("portal_timetable_debug.html", "w") as f:
                f.write(port_tt)
            print("  [!] Raw HTML saved to 'portal_timetable_debug.html'.")
        else:
            print("  [!] Received empty response from portal timetable endpoint.")

    if acad_client:
        print("\n=== ACADEMIA TIMETABLE ===")
        schedule = TimetableService.parse_unified_grid(acad_g1, acad_course_map)
        if not schedule:
            schedule = TimetableService.parse_unified_grid(acad_g2, acad_course_map)
            
        if schedule:
            for day, slots in schedule.items():
                print(f"\n  {day}:")
                for time, details in slots.items():
                    print(f"    {time} -> {details['slot']} | {details['course']} ({details['room']})")
        else:
            print("  Could not fetch/parse academia timetable.")

    print("\n=== STATIC CALENDAR ===")
    try:
        import json
        from datetime import datetime
        cal_path = os.path.join(os.path.dirname(__file__), 'calendar_data.json')
        with open(cal_path, 'r') as f:
            cal_data = json.load(f)
        
        now = datetime.now()
        target = now.strftime("%d %b %Y")
        
        today_idx = -1
        for i, entry in enumerate(cal_data):
            if entry.get("date") == target:
                today_idx = i
                break
                
        if today_idx != -1:
            today = cal_data[today_idx]
            print(f"  Today: {today['date']} ({today['day']})")
            print(f"  Current Day Order: {today.get('order', '-')}")
            if today.get('description'):
                print(f"  Info: {today['description']}")
                
            print("\n  Upcoming 10 Days:")
            for entry in cal_data[today_idx + 1 : today_idx + 11]:
                print(f"    {entry['date']} - {entry['day']} | Order: {entry.get('order', '-')} | {entry.get('description', '')}")
        else:
            print(f"  Date '{target}' not found in calendar_data.json.")
    except Exception as e:
        print(f"  Could not load static calendar: {e}")

if __name__ == "__main__":
    asyncio.run(main())
