import json
import re

# Load products database
with open(r"c:\Users\Usuario\Downloads\CRM_DOIT_DASHBOARD-main\CRM_DOIT_DASHBOARD-main\doit_products.json", "r", encoding="utf-8") as f:
    products_db = json.load(f)

# Collect all non-empty references as uppercase strings
known_refs = set()
for p in products_db:
    ref = p.get("reference", "").strip()
    if ref and len(ref) >= 3: # only valid references
        known_refs.add(ref.upper())

# Print some known refs
print(f"Number of unique known references: {len(known_refs)}")

# Load base data
with open(r"c:\Users\Usuario\Downloads\CRM_DOIT_DASHBOARD-main\CRM_DOIT_DASHBOARD-main\crm_jira_2022_2026_base_autonomo.json", "r", encoding="utf-8") as f:
    base_data = json.load(f)

activities = base_data.get("activities", [])
products = [a for a in activities if a.get("line_kind") == "Producto"]

resolved = 0
unresolved_items = []

for a in products:
    ref = a.get("reference", "").strip().upper()
    prod_name = a.get("product_name", "").strip()
    summary = a.get("summary", "").strip()
    
    final_ref = None
    if ref:
        final_ref = ref
    else:
        # Search for any known reference inside the name or summary as a word
        # Let's tokenize by non-alphanumeric chars
        words = re.findall(r'[A-Za-z0-9-]+', prod_name + " " + summary)
        for w in words:
            wu = w.upper()
            if wu in known_refs:
                final_ref = wu
                break
        
        # If still not found, try substring matching for known references that are unique/long enough
        if not final_ref:
            combined = (prod_name + " " + summary).upper()
            # Sort references by length descending to match longest first
            for kr in sorted(known_refs, key=len, reverse=True):
                # Ensure we match it as a word-like boundary or at least not as part of a larger letters-only word
                if kr in combined:
                    final_ref = kr
                    break
                    
    if final_ref:
        resolved += 1
    else:
        unresolved_items.append((prod_name, summary))

print(f"Total product activities: {len(products)}")
print(f"Resolved product activities (with ref): {resolved}")
print(f"Unresolved: {len(unresolved_items)}")

# Print top 15 unresolved
unresolved_counts = {}
for prod_name, summary in unresolved_items:
    key = prod_name or summary
    unresolved_counts[key] = unresolved_counts.get(key, 0) + 1

print("\nTop unresolved items:")
for key, count in sorted(unresolved_counts.items(), key=lambda x: x[1], reverse=True)[:15]:
    print(f"- {key} (occurrences: {count})")
