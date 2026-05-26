import os
import re

file_path = r"c:\Users\Usuario\Downloads\CRM_DOIT_DASHBOARD-main\CRM_DOIT_DASHBOARD-main\dashboard_v2.html"

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# Let's search using regex to match flexible whitespaces
pattern = r'(<div\s+class="topbar-search"\s*>\s*<input\s+id="searchInput"[^>]*>\s*<div\s+id="searchSuggestions"[^>]*>\s*</div>\s*</div>)'

match = re.search(pattern, content)
if match:
    original = match.group(1)
    replacement = original + '\n      <div id="topbarFilterIndicator" class="topbar-filter-indicator" style="display:none; margin-left:12px;"></div>'
    new_content = content.replace(original, replacement)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    print("SUCCESS: Target replaced using regular expressions!")
else:
    print("ERROR: Target regex pattern not matched!")
    # Let's inspect the nearby content safely
    index = content.find('id="searchInput"')
    if index != -1:
        chunk = content[max(0, index-100) : min(len(content), index+300)]
        print("Nearby content (safe ascii):")
        print(chunk.encode('ascii', errors='replace').decode('ascii'))
