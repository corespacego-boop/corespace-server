import asyncio
import json
import sys
import getpass
from core.academia_client import AcademiaClient
from services.course_service import CourseService
from services.timetable_service import TimetableService

async def main():
    print("=== Academia Terminal Login ===")
    username = input("Email / NetID: ")
    password = getpass.getpass("Password: ")
    
    client = AcademiaClient(username, password)
    
    # Attempt login
    try:
        await client.authenticate()
    except Exception as e:
        err_str = str(e)
        try:
            err_data = json.loads(err_str)
            if err_data.get("type") == "CAPTCHA_REQUIRED":
                print(f"\n[!] Captcha Required: {err_data.get('message')}")
                print(f"Please open this URL in your browser to view the Captcha:")
                print(err_data.get('image'))
                print("-" * 50)
                captcha_ans = input("Enter Captcha: ")
                cdigest = err_data.get("cdigest")
                
                # Retry with captcha
                try:
                    await client.authenticate(captcha_ans, cdigest)
                except Exception as e2:
                    print(f"Login failed: {e2}")
                    sys.exit(1)
        except json.JSONDecodeError:
            print(f"Login failed: {err_str}")
            sys.exit(1)

    print("\n[+] Login successful! Fetching data...")
    
    # Fetch profile (for batch info)
    profile_html = await client.get_profile_html()
    if not profile_html:
        print("Failed to fetch profile.")
        sys.exit(1)
        
    # Fetch course details to build course map
    course_map = CourseService.get_course_map(profile_html)
    print(f"\n=== Course Details ({len(course_map)} slots found) ===")
    for slot, course in course_map.items():
        print(f"[{slot}] {course['code']} - {course['name']} ({course['type']})")
    
    # We need the batch to fetch the right timetable grid
    # For simplicity, we just fetch both and see which one parses properly
    print("\nFetching timetable...")
    grid1_html = await client.get_grid_html("Batch_1")
    grid2_html = await client.get_grid_html("batch_2")
    
    schedule = TimetableService.parse_unified_grid(grid1_html, course_map)
    if not schedule:
        schedule = TimetableService.parse_unified_grid(grid2_html, course_map)
        
    print("\n=== Timetable ===")
    if not schedule:
        print("Could not parse timetable (or no classes scheduled).")
    else:
        for day, slots in schedule.items():
            print(f"\n{day}:")
            for time, details in slots.items():
                print(f"  {time} -> {details['slot']} | {details['course']} ({details['room']})")

if __name__ == "__main__":
    asyncio.run(main())
