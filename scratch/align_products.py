import csv
import io
import json
import re
import subprocess
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASE_JSON = ROOT / "crm_jira_2022_2026_base_autonomo.json"
PRODUCTS_JSON = ROOT / "doit_products.json"
DASHBOARD_HTML = ROOT / "dashboard_v2.html"
JIRA_CSV = ROOT / "Jira.csv"
REPORT_JSON = ROOT / "scratch" / "product_alignment_report.json"


INVALID_REFS = {
    "A", "APP", "AUDIO", "AROMATERAPIA", "BLUETOOTH", "BOLAS", "BURBUJAS",
    "CANALS", "CENTRO", "CLASICA", "COLORS", "COM", "CONSOLE", "DOIT",
    "DOITLINK", "ENCHUFES", "HOPTO", "HOPTOYS", "JBL", "LED", "LUZ", "OPTI",
    "PARED", "PASSIVA", "PASSIVE", "PVC", "RGB", "SALA", "SCREEN",
    "TAPISSATS", "TACTILE", "TENEN", "TUBE", "TUNEL", "USB", "UV",
    "VESTIBULARES", "VIBRO", "WIFI", "CHRISTMAS", "HOPTOY",
    "AIWA", "AIGUA", "ANIMALES", "ANG", "ANTENA", "AROMATERAPIA",
    "AUDITIVAS", "BOMBOLLES", "BURBUJAS", "CAST", "CHROMECAST",
    "DIAMETRE", "DISTANCIA", "ELECTRONICA", "ELEMENTOS", "GRUESA",
    "INFINIT", "INTERACTIVE", "LOGITECH", "MADERA", "MARXA", "MONT",
    "MULTISENSORIAL", "MUNTATGE", "ONES", "PECES", "PLUGS", "PULSADORES",
    "PI3", "PI4", "PULSADORS", "SOPORTE", "ULTRAANGULAR", "VIBRATION", "VISIBLE", "WALL",
}

SERVICE_MARKERS = (
    "INSTALACION", "INSTALACIO", "INSTAL.LACIO", "INSTAL",
    "TRANSPORTE", "MONTAJE", "MONTATGE", "MONT", "MANTENIMIENTO",
    "MANTENIMENT", "MANTPREV", "REPARACION", "REPARACIO", "TRASLLAT",
)

MANUAL_PRODUCT_ALIASES = {
    "CONSOLA DOIT": {
        "product_name": "DOIT CONSOLE SISTEMA DE CONTROL DE ENTORNO Y ACTIVIDADES DOIT",
        "reference": "DOCONS1",
        "category": "Paneles / control",
    },
}

PRODUCT_CODE_RE = re.compile(r"\b[A-Z0-9][A-Z0-9.-]{1,}[A-Z0-9]\b")
ISSUE_KEY_RE = re.compile(r"^DOIT-\d+$")
COM_RE = re.compile(r"^COM\d+[A-Z0-9-]*$")
DIMENSION_RE = re.compile(r"^(?:\d+X|\d+(?:[Xx]\d+){1,4}(?:CM|CMS|M|MM|W)?)$")
UNIT_RE = re.compile(r"^\d+(?:CM|CMS|M|MM|L|W|V|CH|G)$")
UUID_RE = re.compile(r"^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$")
SPANISH_MONTHS = {
    "ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6,
    "jul": 7, "ago": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dic": 12,
}


def norm_ascii(value):
    text = str(value or "")
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return text.upper()


def parse_jira_date(value):
    text = str(value or "").strip()
    match = re.search(
        r"(\d{1,2})/([A-Za-záéíóúÁÉÍÓÚñÑ]+)/(\d{2})\s+(\d{1,2}):(\d{2})\s*([AP]M)",
        text,
        re.I,
    )
    if not match:
        return "", "", None
    day = int(match.group(1))
    month_key = norm_ascii(match.group(2)).lower()
    month = SPANISH_MONTHS.get(month_key)
    if not month:
        return "", "", None
    year = 2000 + int(match.group(3))
    hour = int(match.group(4))
    minute = int(match.group(5))
    ampm = match.group(6).upper()
    if ampm == "PM" and hour != 12:
        hour += 12
    if ampm == "AM" and hour == 12:
        hour = 0
    dt = datetime(year, month, day, hour, minute)
    return dt.strftime("%Y-%m-%d %H:%M"), dt.strftime("%Y-%m-%d"), year


def safe_id(value, limit=80):
    text = norm_ascii(value)
    text = re.sub(r"[^A-Z0-9]+", "_", text).strip("_")
    return (text or "SIN_ID")[:limit]


def is_dimension(token):
    return bool(DIMENSION_RE.match(token) or UNIT_RE.match(token))


def is_valid_reference(token, known_alpha_refs):
    ref = str(token or "").strip().upper().strip(".,;:()[]{}")
    if not ref:
        return False
    if ISSUE_KEY_RE.match(ref) or COM_RE.match(ref) or UUID_RE.match(ref):
        return False
    if ref in INVALID_REFS:
        return False
    if ref.isdigit():
        return len(ref) >= 5
    if is_dimension(ref):
        return False
    has_alpha = any(ch.isalpha() for ch in ref)
    has_digit = any(ch.isdigit() for ch in ref)
    if has_alpha and has_digit:
        return True
    if ref in known_alpha_refs:
        return True
    return False


def extract_candidates(*texts, known_alpha_refs):
    combined = " ".join(str(t or "") for t in texts)
    out = []
    for token in PRODUCT_CODE_RE.findall(norm_ascii(combined)):
        token = token.strip(".,;:()[]{}")
        if token.isdigit():
            continue
        if is_valid_reference(token, known_alpha_refs):
            out.append(token)
    return out


def choose_reference(activity, known_alpha_refs):
    structured = activity.get("structured_fields") or {}
    explicit_values = [
        structured.get("referencia"),
        activity.get("reference"),
    ]
    for value in explicit_values:
        ref = str(value or "").strip().upper()
        if is_valid_reference(ref, known_alpha_refs):
            return ref
    candidates = extract_candidates(
        activity.get("product_name"),
        activity.get("summary"),
        activity.get("description"),
        known_alpha_refs=known_alpha_refs,
    )
    return candidates[-1] if candidates else ""


def parse_quantity(summary):
    text = str(summary or "").strip()
    match = re.match(r"^[.\s-]*(?:X\s*)?(\d+(?:[,.]\d+)?)\b", text, re.I)
    if not match:
        return None
    try:
        return float(match.group(1).replace(",", "."))
    except ValueError:
        return None


def clean_product_name(summary, existing_name="", reference=""):
    name = str(existing_name or summary or "").strip()
    name = re.sub(r"^[.\s-]*(?:X\s*)?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[,.]\d+)?\s*(?:[-–—]\s*)?", "", name, flags=re.I).strip()
    name = re.sub(r"^[,.\s]*00\s+", "", name).strip()
    name = re.sub(r"\s+", " ", name)
    if reference:
        ref_re = re.escape(reference)
        dash = r"[-\u2013\u2014]"
        name = re.sub(rf"^{ref_re}\s*(?:{dash}\s*)?", "", name, flags=re.I).strip()
        name = re.sub(rf"\s*[-–—]?\s*{ref_re}\s*$", "", name, flags=re.I).strip()
    return name or str(summary or "").strip()


def apply_manual_product_alias(product_name, reference, category=""):
    alias = MANUAL_PRODUCT_ALIASES.get(norm_ascii(product_name))
    if not alias:
        return product_name, reference, category
    if reference and reference != alias["reference"]:
        return product_name, reference, category
    return alias["product_name"], alias["reference"], alias.get("category") or category


def is_service_text(text):
    normalized = norm_ascii(text)
    return any(marker in normalized for marker in SERVICE_MARKERS)


def infer_category(name, reference, line_kind):
    text = norm_ascii(f"{name} {reference}")
    if line_kind.startswith("Servicio"):
        return "Servicio / instalacion / transporte"
    if any(x in text for x in ("FIBRA", "FIBRE", "FOS", "DOFO", "DOFF", "FLPAS")):
        return "Fibra optica"
    if any(x in text for x in ("COLUMNA", "BURBUJA", "DOCB", "DTTB")):
        return "Columnas de burbujas"
    if any(x in text for x in ("ESPEJO", "BASE", "COLCH", "PUFF", "SOFA", "DOBAS", "DOES", "BC100", "CA100")):
        return "Mobiliario / tapizado"
    if any(x in text for x in ("CONSOLA", "CONSOLE", "COMUNICADOR", "PANEL", "TABLET", "ENCHUFE", "DO8PULS", "DOCONS", "ENDOIT", "TABADOIT")):
        return "Paneles / control"
    if any(x in text for x in ("PROYECTOR", "LUMINARIA", "LED", "FOCO", "DOITWW", "DOFB", "AST")):
        return "Iluminacion / proyeccion"
    return "Producto / otros"


def status_group(status):
    return "Activa" if norm_ascii(status) in {"A RECIBIR", "EN CURSO", "PENDIENTE"} else "Finalizada"


def quantity_for(activity):
    qty = activity.get("quantity")
    if qty in (None, ""):
        return 1
    try:
        return int(float(qty))
    except (TypeError, ValueError):
        return 1


def line_kind_for(activity):
    line_kind = str(activity.get("line_kind") or "")
    if line_kind.startswith("Servicio"):
        return "Servicio"
    return "Producto" if line_kind == "Producto" else line_kind


def build_known_alpha_refs(data, products):
    refs = set()
    for product in products:
        ref = str(product.get("reference") or "").strip().upper()
        if ref and ref.isalpha() and ref not in INVALID_REFS:
            refs.add(ref)
    for item in data.get("product_catalog", []):
        ref = str(item.get("reference") or "").strip().upper()
        if ref and ref.isalpha() and ref not in INVALID_REFS:
            refs.add(ref)
    return refs


def load_json_from_head(path):
    try:
        rel = path.relative_to(ROOT).as_posix()
        raw = subprocess.check_output(["git", "show", f"HEAD:{rel}"], cwd=ROOT, text=True, encoding="utf-8")
        return json.loads(raw)
    except Exception:
        return json.loads(path.read_text(encoding="utf-8-sig"))


def normalize_existing_activities(data, known_alpha_refs):
    changed = []
    for activity in data.get("activities", []):
        if line_kind_for(activity) != "Producto":
            continue
        old_ref = str(activity.get("reference") or "").strip().upper()
        new_ref = choose_reference(activity, known_alpha_refs)
        old_name = activity.get("product_name") or activity.get("summary") or ""
        new_name = clean_product_name(activity.get("summary"), old_name, new_ref)
        new_name, new_ref, new_category = apply_manual_product_alias(new_name, new_ref, activity.get("category") or "")
        if old_ref != new_ref or old_name != new_name:
            changed.append({
                "key": activity.get("key"),
                "old_reference": old_ref,
                "new_reference": new_ref,
                "old_name": old_name,
                "new_name": new_name,
            })
        activity["reference"] = new_ref
        activity["product_name"] = new_name
        if new_category:
            activity["category"] = new_category
        elif not activity.get("category") or activity.get("category") == "Producto / otros":
            activity["category"] = infer_category(new_name, new_ref, "Producto")
    return changed


def load_jira_rows():
    text = JIRA_CSV.read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    return [row for row in reader]


def row_to_activity(row, root_epic, known_alpha_refs, raw_row_number):
    created, created_date, created_year = parse_jira_date(row.get("Creada"))
    summary = row.get("Resumen") or ""
    line_kind = "Servicio" if is_service_text(summary) else "Producto"
    stub = {
        "summary": summary,
        "description": row.get("Descripción") or "",
        "reference": "",
        "product_name": summary,
        "structured_fields": {},
    }
    reference = choose_reference(stub, known_alpha_refs)
    product_name = clean_product_name(summary, "", reference)
    product_name, reference, alias_category = apply_manual_product_alias(product_name, reference, "")
    return {
        "id": f"LIN_{row.get('Clave de incidencia')}",
        "key": row.get("Clave de incidencia"),
        "issue_id": row.get("ID de la incidencia") or "",
        "root_epic_key": root_epic["key"],
        "parent_key": root_epic["key"],
        "parent_summary": root_epic["summary"],
        "summary": summary,
        "description": row.get("Descripción") or "",
        "status": row.get("Estado") or "",
        "status_group": status_group(row.get("Estado") or ""),
        "created": created,
        "created_date": created_date,
        "created_year": created_year,
        "quantity": parse_quantity(summary),
        "product_name": product_name,
        "reference": reference,
        "line_kind": line_kind,
        "category": alias_category or infer_category(product_name, reference, line_kind),
        "structured_fields": {},
        "client_id": root_epic["client_id"],
        "client_name": root_epic["client_name"],
        "center_id": root_epic["center_id"],
        "center_name": root_epic["center_name"],
        "com": root_epic.get("com") or "",
        "raw_row_number": raw_row_number,
        "custom": {
            "notes": "Recuperado desde Jira.csv: fila sin Clave principal.",
            "validated": False,
        },
    }


def ensure_orphan_client(data):
    client_id = "CLI_SIN_CLIENTE_IDENTIFICADO_JIRA"
    center_id = "CTR_SIN_CLIENTE_IDENTIFICADO_JIRA"
    if not any(c.get("id") == client_id for c in data.get("clients", [])):
        data.setdefault("clients", []).append({
            "id": client_id,
            "name": "SIN CLIENTE IDENTIFICADO (JIRA SIN EPIC)",
            "type": "Pendiente revisar",
            "contact": {
                "contact_name": "", "email": "", "phone": "", "mobile": "",
                "address": "", "city": "", "country": "", "website": "",
                "notes": "", "source": "Filas de Jira.csv sin EPIC / Clave principal",
            },
            "custom": {"owner": "", "priority": "", "segment": "", "notes": ""},
            "aliases": ["Filas de Jira.csv sin EPIC / Clave principal"],
            "centers": [center_id],
            "epics": [],
            "comandas": [],
            "jira_keys": [],
            "stats": {},
            "review_flags": ["Revisar manualmente: productos sin pedido/cliente en Jira.csv"],
        })
    if not any(c.get("id") == center_id for c in data.get("centers", [])):
        data.setdefault("centers", []).append({
            "id": center_id,
            "client_id": client_id,
            "client_name": "SIN CLIENTE IDENTIFICADO (JIRA SIN EPIC)",
            "name": "Sin centro identificado",
            "kind": "Revision",
            "contact": {"contact_name": "", "email": "", "phone": "", "address": "", "notes": "", "source": ""},
            "epics": [],
            "comandas": [],
            "stats": {},
            "detection_rule": "Filas de Jira.csv sin Clave principal",
        })
    return client_id, center_id


def make_orphan_epic(block, client_id, center_id):
    first = block[0]
    last = block[-1]
    created, created_date, created_year = parse_jira_date(first.get("Creada"))
    key = f"SIN-EPIC-{first.get('Clave de incidencia')}"
    summary = f"Lineas Jira sin EPIC ({first.get('Clave de incidencia')} - {last.get('Clave de incidencia')})"
    return {
        "key": key,
        "issue_id": "",
        "summary": summary,
        "description": "Agrupacion tecnica creada porque Jira.csv contiene lineas de producto sin Clave principal ni Parent summary.",
        "status": first.get("Estado") or "",
        "status_group": status_group(first.get("Estado") or ""),
        "created": created,
        "created_date": created_date,
        "created_year": created_year,
        "com": "",
        "client_id": client_id,
        "client_name": "SIN CLIENTE IDENTIFICADO (JIRA SIN EPIC)",
        "client_confidence": "Revision",
        "center_id": center_id,
        "center_name": "Sin centro identificado",
        "center_rule": "Filas de Jira.csv sin Clave principal",
        "format": "Agrupacion de lineas huerfanas",
        "normalization_rule": "No se inventa cliente; requiere revision manual",
        "structured_fields": {},
        "contact_snapshot": {"contact_name": "", "email": "", "phone": "", "mobile": "", "address": "", "city": "", "country": "", "website": ""},
        "products": [],
        "services": [],
        "activities": [],
        "raw_row_number": None,
        "custom": {"notes": "Revisar cliente/pedido original en Jira.", "commercial_owner": "", "delivery_status": "", "invoice_status": "", "priority": ""},
    }


def contiguous_orphan_blocks(rows):
    blocks = []
    current = []
    previous_dt = None
    for row in rows:
        created, _, _ = parse_jira_date(row.get("Creada"))
        dt = datetime.strptime(created, "%Y-%m-%d %H:%M") if created else None
        if not current:
            current = [row]
            previous_dt = dt
            continue
        gap_minutes = 999999
        if dt and previous_dt:
            gap_minutes = abs((dt - previous_dt).total_seconds()) / 60
        if gap_minutes <= 15:
            current.append(row)
        else:
            blocks.append(current)
            current = [row]
        previous_dt = dt
    if current:
        blocks.append(current)
    return blocks


def nearest_epic_for_orphan(row, epics_by_key):
    key = row.get("Clave de incidencia") or ""
    match = re.match(r"DOIT-(\d+)$", key)
    if not match:
        return None
    number = int(match.group(1))
    created, _, _ = parse_jira_date(row.get("Creada"))
    for offset in range(1, 3):
        epic = epics_by_key.get(f"DOIT-{number - offset}")
        if epic and epic.get("created", "")[:16] == created:
            return epic
    return None


def add_missing_csv_rows(data, known_alpha_refs):
    existing_keys = {a.get("key") for a in data.get("activities", [])} | {e.get("key") for e in data.get("epics", [])}
    parsed_rows = load_jira_rows()
    missing = []
    for idx, row in enumerate(parsed_rows, start=2):
        key = row.get("Clave de incidencia") or ""
        created, _, _ = parse_jira_date(row.get("Creada"))
        if not key.startswith("DOIT-") or key in existing_keys or not created:
            continue
        if row.get("Clave principal") or row.get("Parent summary"):
            continue
        if not (parse_quantity(row.get("Resumen")) or is_service_text(row.get("Resumen"))):
            continue
        row["_csv_row_number"] = idx
        missing.append(row)

    epics_by_key = {e.get("key"): e for e in data.get("epics", [])}
    attached = []
    unresolved = []
    for row in missing:
        epic = nearest_epic_for_orphan(row, epics_by_key)
        if epic:
            activity = row_to_activity(row, epic, known_alpha_refs, row["_csv_row_number"])
            data.setdefault("activities", []).append(activity)
            existing_keys.add(activity["key"])
            attached.append(activity["key"])
        else:
            unresolved.append(row)

    synthetic_epics = []
    if unresolved:
        client_id, center_id = ensure_orphan_client(data)
        for block in contiguous_orphan_blocks(unresolved):
            epic = make_orphan_epic(block, client_id, center_id)
            data.setdefault("epics", []).append(epic)
            epics_by_key[epic["key"]] = epic
            synthetic_epics.append(epic["key"])
            for row in block:
                activity = row_to_activity(row, epic, known_alpha_refs, row["_csv_row_number"])
                data.setdefault("activities", []).append(activity)
                existing_keys.add(activity["key"])

    return {
        "missing_rows_found": len(missing),
        "attached_to_existing_epic": attached,
        "synthetic_epics": synthetic_epics,
    }


def rebuild_indexes(data):
    clients = {c.get("id"): c for c in data.get("clients", [])}
    centers = {c.get("id"): c for c in data.get("centers", [])}
    epics = {e.get("key"): e for e in data.get("epics", [])}
    activities_by_epic = defaultdict(list)
    for activity in data.get("activities", []):
        root = activity.get("root_epic_key") or activity.get("parent_key")
        activities_by_epic[root].append(activity)

    for client in clients.values():
        client["centers"] = []
        client["epics"] = []
        client["comandas"] = []
        client["jira_keys"] = []
        client["stats"] = {"epics": 0, "epics_finalizados": 0, "epics_activos": 0, "productos": 0, "servicios": 0}
    for center in centers.values():
        center["epics"] = []
        center["comandas"] = []
        center["stats"] = {"epics": 0, "epics_finalizados": 0, "epics_activos": 0, "productos": 0, "servicios": 0}

    for epic in data.get("epics", []):
        acts = sorted(activities_by_epic.get(epic.get("key"), []), key=lambda a: (a.get("created") or "", a.get("key") or ""))
        products = [a for a in acts if line_kind_for(a) == "Producto"]
        services = [a for a in acts if line_kind_for(a).startswith("Servicio")]
        epic["activities"] = [a.get("key") for a in acts]
        epic["products"] = [a.get("id") for a in products]
        epic["services"] = [a.get("id") for a in services]
        epic["activity_count"] = len(acts)
        epic["product_count"] = len(products)
        epic["service_count"] = len(services)
        epic["internal_count"] = 0
        epic["first_activity_created"] = acts[0].get("created") if acts else ""
        epic["last_activity_created"] = acts[-1].get("created") if acts else ""

        client = clients.get(epic.get("client_id"))
        center = centers.get(epic.get("center_id"))
        if client:
            client["epics"].append(epic.get("key"))
            client["jira_keys"].append(epic.get("key"))
            if epic.get("center_id") and epic.get("center_id") not in client["centers"]:
                client["centers"].append(epic.get("center_id"))
            if epic.get("com") and epic.get("com") not in client["comandas"]:
                client["comandas"].append(epic.get("com"))
            client["stats"]["epics"] += 1
            if epic.get("status_group") == "Activa":
                client["stats"]["epics_activos"] += 1
            else:
                client["stats"]["epics_finalizados"] += 1
        if center:
            center["epics"].append(epic.get("key"))
            if epic.get("com") and epic.get("com") not in center["comandas"]:
                center["comandas"].append(epic.get("com"))
            center["stats"]["epics"] += 1
            if epic.get("status_group") == "Activa":
                center["stats"]["epics_activos"] += 1
            else:
                center["stats"]["epics_finalizados"] += 1

    for activity in data.get("activities", []):
        qty = quantity_for(activity)
        client = clients.get(activity.get("client_id"))
        center = centers.get(activity.get("center_id"))
        kind = line_kind_for(activity)
        if kind == "Producto":
            if client:
                client["stats"]["productos"] += qty
            if center:
                center["stats"]["productos"] += qty
        elif kind.startswith("Servicio"):
            if client:
                client["stats"]["servicios"] += qty
            if center:
                center["stats"]["servicios"] += qty

    for client in clients.values():
        epics_for_client = [epics[k] for k in client.get("epics", []) if k in epics]
        dates = [e.get("created") for e in epics_for_client if e.get("created")]
        if dates:
            client["stats"]["primer_epic"] = min(dates)
            client["stats"]["ultimo_epic"] = max(dates)
    for center in centers.values():
        epics_for_center = [epics[k] for k in center.get("epics", []) if k in epics]
        dates = [e.get("created") for e in epics_for_center if e.get("created")]
        if dates:
            center["stats"]["primer_epic"] = min(dates)
            center["stats"]["ultimo_epic"] = max(dates)


def rebuild_evolution(data):
    global_rows = defaultdict(lambda: {"epics": 0, "epics_con_com": 0, "epics_sin_com": 0, "epics_activos": 0, "actividades": 0, "productos": 0, "servicios": 0, "desc_estructuradas": 0})
    client_rows = defaultdict(lambda: {"epics": 0, "epics_con_com": 0, "epics_sin_com": 0, "epics_activos": 0, "actividades": 0, "productos": 0, "servicios": 0})
    activities_by_epic = defaultdict(list)
    for activity in data.get("activities", []):
        activities_by_epic[activity.get("root_epic_key") or activity.get("parent_key")].append(activity)
    clients = {c.get("id"): c for c in data.get("clients", [])}

    for epic in data.get("epics", []):
        year = epic.get("created_year")
        if not year:
            continue
        client_id = epic.get("client_id")
        global_rows[year]["epics"] += 1
        client_rows[(client_id, year)]["epics"] += 1
        if epic.get("com"):
            global_rows[year]["epics_con_com"] += 1
            client_rows[(client_id, year)]["epics_con_com"] += 1
        else:
            global_rows[year]["epics_sin_com"] += 1
            client_rows[(client_id, year)]["epics_sin_com"] += 1
        if epic.get("status_group") == "Activa":
            global_rows[year]["epics_activos"] += 1
            client_rows[(client_id, year)]["epics_activos"] += 1
        for activity in activities_by_epic.get(epic.get("key"), []):
            kind = line_kind_for(activity)
            global_rows[year]["actividades"] += 1
            client_rows[(client_id, year)]["actividades"] += 1
            if kind == "Producto":
                global_rows[year]["productos"] += 1
                client_rows[(client_id, year)]["productos"] += 1
            elif kind.startswith("Servicio"):
                global_rows[year]["servicios"] += 1
                client_rows[(client_id, year)]["servicios"] += 1

    data["evolution_global"] = [{"year": year, **values} for year, values in sorted(global_rows.items())]
    data["evolution_by_client"] = [
        {"client_id": client_id, "client_name": clients.get(client_id, {}).get("name", ""), "year": year, **values}
        for (client_id, year), values in sorted(client_rows.items(), key=lambda item: (clients.get(item[0][0], {}).get("name", ""), item[0][1]))
    ]


def rebuild_product_catalog(data):
    groups = {}
    for activity in data.get("activities", []):
        kind = line_kind_for(activity)
        if kind != "Producto":
            continue
        name = clean_product_name(activity.get("summary"), activity.get("product_name"), activity.get("reference"))
        ref = str(activity.get("reference") or "").strip().upper()
        key = (ref or safe_id(name), name, kind)
        if key not in groups:
            groups[key] = {
                "reference": ref,
                "product_name": name,
                "line_kind": kind,
                "category": activity.get("category") or infer_category(name, ref, kind),
                "total_quantity": 0.0,
                "line_count": 0,
                "epics": set(),
                "clients": set(),
            }
        groups[key]["total_quantity"] += float(quantity_for(activity))
        groups[key]["line_count"] += 1
        if activity.get("root_epic_key"):
            groups[key]["epics"].add(activity.get("root_epic_key"))
        if activity.get("client_name"):
            groups[key]["clients"].add(activity.get("client_name"))

    catalog = []
    id_counts = Counter()
    for item in sorted(groups.values(), key=lambda x: (x["reference"] or "ZZZ", x["product_name"])):
        base = safe_id(item["reference"] or item["product_name"])
        id_counts[base] += 1
        suffix = "" if id_counts[base] == 1 else f"_{id_counts[base]}"
        catalog.append({
            "id": f"CAT_{base}{suffix}",
            "reference": item["reference"],
            "product_name": item["product_name"],
            "line_kind": item["line_kind"],
            "category": item["category"],
            "total_quantity": item["total_quantity"],
            "line_count": item["line_count"],
            "epics": sorted(item["epics"]),
            "clients": sorted(item["clients"]),
        })
    data["product_catalog"] = catalog

    products = [
        {"name": item["product_name"], "reference": item["reference"], "occurrences": item["line_count"]}
        for item in catalog
    ]
    products.sort(key=lambda x: (x["name"].casefold(), x["reference"]))
    return products


def replace_script_json(html, script_id, payload):
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    pattern = re.compile(rf'(<script[^>]*id="{re.escape(script_id)}"[^>]*>)(.*?)(</script>)', re.S)
    next_html, count = pattern.subn(lambda match: match.group(1) + text + match.group(3), html, count=1)
    if count != 1:
        raise RuntimeError(f"No se encontro script {script_id}")
    return next_html


def main():
    data = load_json_from_head(BASE_JSON)
    products = load_json_from_head(PRODUCTS_JSON)
    known_alpha_refs = build_known_alpha_refs(data, products)

    changed = normalize_existing_activities(data, known_alpha_refs)
    missing_info = add_missing_csv_rows(data, known_alpha_refs)
    rebuild_indexes(data)
    rebuild_evolution(data)
    products = rebuild_product_catalog(data)

    data.setdefault("metadata", {})
    data["metadata"].update({
        "reference_alignment": "Referencias de producto normalizadas desde actividades, product_catalog y Jira.csv",
        "reference_aligned_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "jira_csv_current_rows_parsed": len(load_jira_rows()),
        "jira_csv_missing_rows_added": missing_info["missing_rows_found"],
        "product_catalog_entries": len(data.get("product_catalog", [])),
        "products_json_entries": len(products),
    })

    BASE_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    PRODUCTS_JSON.write_text(json.dumps(products, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    html = DASHBOARD_HTML.read_text(encoding="utf-8")
    html = replace_script_json(html, "seed-data", data)
    html = replace_script_json(html, "products-data", products)
    DASHBOARD_HTML.write_text(html, encoding="utf-8")

    report = {
        "normalized_existing_activity_count": len(changed),
        "normalized_reference_examples": changed[:50],
        **missing_info,
        "product_catalog_entries": len(data.get("product_catalog", [])),
        "products_json_entries": len(products),
    }
    REPORT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
