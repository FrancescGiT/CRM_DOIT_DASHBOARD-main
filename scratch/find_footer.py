with open(r"c:\Users\Usuario\Downloads\CRM_DOIT_DASHBOARD-main\CRM_DOIT_DASHBOARD-main\dashboard_v2.html", "r", encoding="utf-8") as f:
    content = f.read()

index = content.find('searchInput')
if index != -1:
    print("Found searchInput at index", index)
    start = max(0, index - 300)
    end = min(len(content), index + 500)
    chunk = content[start:end]
    print(chunk.encode('ascii', errors='replace').decode('ascii'))
else:
    print("searchInput not found!")
