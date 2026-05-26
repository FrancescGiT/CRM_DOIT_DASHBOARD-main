import json
import re

# Replicate the JS lookup and detection logic
with open(r"c:\Users\Usuario\Downloads\CRM_DOIT_DASHBOARD-main\CRM_DOIT_DASHBOARD-main\doit_products.json", "r", encoding="utf-8") as f:
    products_db = json.load(f)

name_to_ref = {}
known_refs = set()
for p in products_db:
    name = p.get("name", "").strip()
    ref = p.get("reference", "").strip().upper()
    if ref:
        known_refs.add(ref)
        if name:
            name_to_ref[name.lower()] = ref

def detect_reference(name, summary, explicit_ref):
    r = (explicit_ref or "").strip().upper()
    if r:
        return r
    n = (name or "").strip()
    s = (summary or "").strip()
    if n and n.lower() in name_to_ref:
        return name_to_ref[n.lower()]
    if s and s.lower() in name_to_ref:
        return name_to_ref[s.lower()]
    
    combined = (n + " " + s).upper()
    tokens = re.findall(r'[A-Z0-9-]+', combined)
    for t in tokens:
        if t in known_refs:
            return t
            
    # Substring match
    for kr in sorted(known_refs, key=len, reverse=True):
        if len(kr) >= 3 and kr in combined:
            return kr
    return ""

with open(r"c:\Users\Usuario\Downloads\CRM_DOIT_DASHBOARD-main\CRM_DOIT_DASHBOARD-main\crm_jira_2022_2026_base_autonomo.json", "r", encoding="utf-8") as f:
    base_data = json.load(f)

# Re-index
product_sales = {}
for a in base_data.get("activities", []):
    if a.get("line_kind") == "Producto":
        prod_name = a.get("product_name", "").strip()
        ref_code = detect_reference(prod_name, a.get("summary", ""), a.get("reference", ""))
        ref = ref_code or prod_name
        
        if not ref:
            continue
            
        if ref not in product_sales:
            product_sales[ref] = {
                "reference": ref_code,
                "name": prod_name,
                "years": {},
                "details": []
            }
            
        epic_key = a.get("root_epic_key") or a.get("parent_key") or ""
        # Find epic year
        year = a.get("created_year")
        if not year:
            created = a.get("created_date") or a.get("created")
            if created:
                # E.g. "04/nov/25 1:16 PM" or "2024-05-24"
                # Let's extract 4 digits if present
                m = re.search(r'\b(202\d)\b', created)
                if m:
                    year = m.group(1)
                else:
                    # check format dd/mmm/yy
                    m2 = re.search(r'/([2-6]\d)\b', created)
                    if m2:
                        year = "20" + m2.group(1)
                    else:
                        year = "Desconocido"
            else:
                year = "Desconocido"
                
        qty = int(a.get("quantity") or 1)
        product_sales[ref]["years"][year] = product_sales[ref]["years"].get(year, 0) + qty
        product_sales[ref]["details"].append({
            "epic_key": epic_key,
            "quantity": qty,
            "line_description": prod_name,
            "year": year
        })

# Check DOCB15DOIT stats
stats = product_sales.get("DOCB15DOIT")
if stats:
    print("DOCB15DOIT Stats:")
    print(f"Reference: {stats['reference']}")
    print(f"Name: {stats['name']}")
    print("Sales per year:")
    total = 0
    for yr in sorted(stats["years"].keys()):
        val = stats["years"][yr]
        print(f"- {yr}: {val} units")
        total += val
    print(f"Total units sold: {total}")
    print(f"Total entries in details: {len(stats['details'])}")
else:
    print("DOCB15DOIT was not found in product_sales!")
