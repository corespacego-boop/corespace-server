import asyncio
import base64
import json
import sys
import getpass
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'academia')))

from portal_client import PortalSession, PortalClient
from portal_attendance_service import PortalAttendanceService
from portal_timetable_service import PortalTimetableService
from portal_profile_service import PortalProfileService
from portal_marks_service import PortalMarksService

async def main():
    print("=== Portal Terminal Login ===")
    username = input("Portal ID (e.g. 1000...): ")
    password = getpass.getpass("Password: ")
    
    session = PortalSession()
    
    print("\n[+] Loading captcha...")
    try:
        captcha_info = await session.load_captcha()
    except Exception as e:
        print(f"Failed to load portal: {e}")
        sys.exit(1)
        
    b64_image = captcha_info.get("captcha_image")
    if b64_image and b64_image.startswith("data:image/png;base64,"):
        b64_data = b64_image.split(",")[1]
        with open("captcha.png", "wb") as f:
            f.write(base64.b64decode(b64_data))
        print("[!] Captcha saved as 'captcha.png' in the current directory.")
        print("Please open it, read the text, and enter it below.")
        captcha_ans = input("Enter Captcha: ")
    else:
        print("No captcha required or failed to parse captcha image.")
        captcha_ans = ""
        
    print("\n[+] Logging in...")
    res = await session.login(username, password, captcha_ans)
    
    if not res.get("ok"):
        print(f"Login failed: {res.get('message', res.get('reason'))}")
        sys.exit(1)
        
    print("[+] Login successful! Fetching data...")
    cookies = res["cookies"]
    client = PortalClient(cookies)
    
    # Fetch data concurrently
    att_html, marks, tt_html, prof_html = await asyncio.gather(
        client.get_attendance_html(),
        client.get_marks_data(),
        client.get_timetable_html(),
        client.get_profile_html()
    )
    
    # Profile
    if prof_html:
        profile = PortalProfileService.parse(prof_html)
        print("\n=== Personal Details ===")
        for k, v in profile.items():
            print(f"  {k.capitalize()}: {v}")
    
    # Attendance
    if att_html:
        courses, monthly = PortalAttendanceService.parse(att_html)
        print(f"\n=== Attendance ({len(courses)} courses) ===")
        for c in courses:
            print(f"  [{c['code']}] {c['title']} - {c['percent']}% ({c['present']}/{c['conducted']})")
            
    # Marks
    if marks:
        print(f"\n=== Marks ({len(marks)} courses) ===")
        for m in marks:
            total = m.get('totalMarkGot', 'N/A')
            max_marks = m.get('totalMaxMarks', 'N/A')
            print(f"  [{m['courseCode']}] {m['title']} -> {total} / {max_marks}")
            if m.get('assessments'):
                for a in m['assessments']:
                    print(f"      - {a['title']}: {a['marks']}/{a['total']}")

    # Timetable
    if tt_html:
        schedule, course_map = PortalTimetableService.parse(tt_html)
        print("\n=== Timetable ===")
        if schedule:
            for day, slots in schedule.items():
                print(f"\n  {day}:")
                for time, details in slots.items():
                    print(f"    {time} -> {details['slot']} | {details['course']} ({details['room']})")
        else:
            print("  No timetable data parsed.")
            
if __name__ == "__main__":
    asyncio.run(main())
