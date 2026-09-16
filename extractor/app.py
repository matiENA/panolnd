import os
import re
import io
import glob
import shutil
import json
import socket
import webbrowser
import datetime
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pdfplumber
import gspread
from google.oauth2.service_account import Credentials

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

app = FastAPI(title="OT Sheets Extractor")

class CustomCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        origin = request.headers.get("origin", "*")
        if request.method == "OPTIONS":
            res = Response(content="OK", status_code=200)
        else:
            res = await call_next(request)
        res.headers["Access-Control-Allow-Origin"] = origin
        res.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        res.headers["Access-Control-Allow-Headers"] = "*"
        res.headers["Access-Control-Allow-Credentials"] = "true"
        res.headers["Access-Control-Allow-Private-Network"] = "true"
        return res

app.add_middleware(CustomCORSMiddleware)

# Configuration
SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID", "17yFPBMz8ExHf53e6ssh9LyDTjKCCJApoiCNXP-4KINQ")
TAB_NAME = "ots"
SERVICE_ACCOUNT_EMAIL = "firebase-adminsdk-fbsvc@ute-logistica.iam.gserviceaccount.com"

DEFAULT_LOCAL_OT_FOLDER = r"C:\Users\Matias Rodriguez\Documents\docs\otsE"
OT_FOLDER = os.environ.get(
    "OT_FOLDER",
    DEFAULT_LOCAL_OT_FOLDER if os.path.exists(DEFAULT_LOCAL_OT_FOLDER) else os.path.join(os.path.dirname(__file__), "otsE")
)
DOWNLOADS_FOLDER = os.environ.get("DOWNLOADS_FOLDER", r"C:\Users\Matias Rodriguez\Downloads")
REGISTRY_PATH = os.path.join(OT_FOLDER, "registro_ots.json")
CARGADAS_TRACKER_PATH = os.path.join(OT_FOLDER, "cargadas_tracker.json")
PARSED_CACHE_PATH = os.path.join(OT_FOLDER, "parsed_pdf_cache.json")

def load_cargadas_tracker() -> dict:
    if os.path.exists(CARGADAS_TRACKER_PATH):
        try:
            with open(CARGADAS_TRACKER_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_cargadas_tracker(tracker: dict):
    ensure_folders()
    try:
        with open(CARGADAS_TRACKER_PATH, "w", encoding="utf-8") as f:
            json.dump(tracker, f, indent=2)
    except Exception as e:
        print(f"Error saving cargadas tracker: {e}")

CREDENTIAL_CANDIDATES = [
    os.path.join(os.path.dirname(__file__), "service_account.json"),
    r"C:\Users\Matias Rodriguez\Desktop\gs account\ute-logistica-firebase-adminsdk-fbsvc-04f3a4a36e.json",
    r"C:\Users\Matias Rodriguez\Documents\sheet bs\pintardisp\ute-logistica-key.json",
]

KNOWN_SECTORS = [
    'ENGRASE', 'Gomeria', 'Lavadero', 'LUBRICENTRO', 'Mecanica', 'Electricidad',
    'Carroceria', 'Herreria', 'Pintura', 'Chaperia', 'Gomería', 'Mecánica',
    'Lubricentro', 'Engrase', 'MECANICA', 'GOMERIA', 'LAVADERO', 'ELECTRICIDAD', 'CARROCERIA'
]

HEADERS = [
    "KEY",
    "FECHA INGRESO",
    "ORDEN Nº",
    "DOMINIO",
    "SECTOR / TAREAS",
    "CIERRE / RESPALDO TAREAS",
    "PAYLOAD",
    "CONFIRMACIÓN DE TAREAS"
]

def ensure_folders():
    os.makedirs(OT_FOLDER, exist_ok=True)

def sync_downloads_to_ot_folder():
    """Mueve automáticamente cualquier OT_*.pdf nuevo de Downloads hacia otsE"""
    ensure_folders()
    moved_count = 0
    if os.path.exists(DOWNLOADS_FOLDER):
        for f in glob.glob(os.path.join(DOWNLOADS_FOLDER, "OT_*.pdf")):
            dest = os.path.join(OT_FOLDER, os.path.basename(f))
            try:
                shutil.move(f, dest)
                moved_count += 1
            except Exception:
                pass
    return moved_count

def get_registered_ots() -> set:
    if os.path.exists(REGISTRY_PATH):
        try:
            with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                return set(str(x) for x in data.get("ot_numbers", []))
        except Exception:
            pass
    return set()

def save_registered_ots(ot_set: set):
    ensure_folders()
    ot_list = sorted(list(ot_set), key=lambda x: int(x) if str(x).isdigit() else str(x))
    with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "total": len(ot_list),
            "last_updated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "ot_numbers": ot_list
        }, f, indent=2)

SIX_MONTHS_SECONDS = 180 * 24 * 60 * 60

def normalize_plate(plate_str: str) -> str:
    if not plate_str: return ""
    return re.sub(r'[\s\-_.]', '', str(plate_str)).upper()

def normalize_ot(ot_str: str) -> str:
    if not ot_str: return ""
    clean = re.sub(r'\.0+$', '', str(ot_str).strip())
    no_zeros = re.sub(r'^0+', '', clean)
    return no_zeros or clean

def parse_date_score(date_str: str, ot_str: str = "") -> float:
    if not date_str:
        return 0.0
    s = str(date_str).strip()
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?', s)
    if m:
        try:
            d = int(m.group(1))
            mo = int(m.group(2))
            y = int(m.group(3))
            h = int(m.group(4)) if m.group(4) else 0
            mi = int(m.group(5)) if m.group(5) else 0
            sec = int(m.group(6)) if m.group(6) else 0
            return datetime.datetime(y, mo, d, h, mi, sec).timestamp()
        except Exception:
            pass
    try:
        return datetime.datetime.fromisoformat(s).timestamp()
    except Exception:
        pass
    try:
        return float(re.sub(r'\D', '', str(ot_str)))
    except Exception:
        return 0.0

def load_parsed_cache() -> dict:
    if os.path.exists(PARSED_CACHE_PATH):
        try:
            with open(PARSED_CACHE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_parsed_cache(cache: dict):
    ensure_folders()
    try:
        with open(PARSED_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2)
    except Exception as e:
        print(f"Error saving parsed cache: {e}")

def get_service_account_path():
    for path in CREDENTIAL_CANDIDATES:
        if os.path.exists(path):
            return path
    return None

def get_gspread_client():
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]
    # 1. Chequear variable de entorno GOOGLE_CREDENTIALS (Render Cloud)
    env_creds = os.environ.get("GOOGLE_CREDENTIALS")
    if env_creds:
        try:
            creds_info = json.loads(env_creds)
            creds = Credentials.from_service_account_info(creds_info, scopes=scopes)
            return gspread.authorize(creds)
        except Exception as e:
            print(f"Error parseando GOOGLE_CREDENTIALS env var: {e}")

    # 2. Chequear archivos candidatos locales (Local Windows)
    cred_path = get_service_account_path()
    if cred_path:
        creds = Credentials.from_service_account_file(cred_path, scopes=scopes)
        return gspread.authorize(creds)

    raise HTTPException(
        status_code=500,
        detail="No se encontró credenciales de cuenta de servicio (ni GOOGLE_CREDENTIALS ni archivo JSON local)."
    )

def format_sector_task(raw_text: str):
    if not raw_text:
        return "", ""
    lines = [l.strip() for l in raw_text.split('\n') if l.strip()]
    if len(lines) >= 2:
        sector = lines[0]
        task_name = ' '.join(lines[1:])
        return f"[{sector}] {task_name}", f"[{sector} - {task_name}]"
    elif len(lines) == 1:
        text = lines[0]
        for sec in KNOWN_SECTORS:
            if text.lower().startswith(sec.lower()):
                task_name = text[len(sec):].strip()
                return f"[{sec}] {task_name}", f"[{sec} - {task_name}]"
        return f"[{text}]", f"[{text}]"
    return raw_text, raw_text

def extract_patente(dominio_raw: str) -> str:
    if not dominio_raw:
        return ""
    clean = re.sub(r'\s*Kms?:.*$', '', dominio_raw, flags=re.IGNORECASE).strip()
    if '|' in clean:
        clean = clean.split('|')[0].strip()
    plate_match = re.search(r'([a-zA-Z]{2}\s*\d{3}\s*[a-zA-Z]{2}|[a-zA-Z]{3}\s*\d{3})', clean)
    if plate_match:
        return re.sub(r'\s+', '', plate_match.group(1).upper())
    return clean.split()[0].strip() if clean else ""

def extract_confirmacion(full_text: str) -> str:
    if not re.search(r'requiere confirmaci[^\n\r]*de tareas', full_text, re.IGNORECASE):
        return ""
    
    m_est = re.search(r'Estado:\s*([^\n\r]+)', full_text, re.IGNORECASE)
    m_fec = re.search(r'Fecha\s*confirmaci[^\n\r:]*:\s*([^\n\r]+)', full_text, re.IGNORECASE)
    m_op = re.search(r'Operador:\s*([^\n\r]+)', full_text, re.IGNORECASE)

    estado = m_est.group(1).strip() if m_est else ""
    fecha = m_fec.group(1).strip() if m_fec else ""
    operador = m_op.group(1).strip() if m_op else ""

    if 'confirmada' in estado.lower():
        parts = ["Confirmada"]
        if fecha:
            parts.append(f"Fecha: {fecha}")
        if operador:
            parts.append(f"Operador: {operador}")
        return " - ".join(parts)
    elif 'sin confirmar' in estado.lower():
        return "Sin confirmar"
    elif estado:
        parts = [estado]
        if fecha:
            parts.append(f"Fecha: {fecha}")
        if operador:
            parts.append(f"Operador: {operador}")
        return " - ".join(parts)
    return ""

def parse_pdf_content(file_bytes: bytes, filename: str) -> dict:
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        full_text = "\n".join([page.extract_text() or "" for page in pdf.pages])
        
        # 1. ORDEN Nº
        orden_match = re.search(r'ORDEN\s*N[^\d\n\r]*?(\d+)', full_text, re.IGNORECASE)
        if not orden_match:
            orden_match = re.search(r'ORDEN\s*N[\s\S]{0,100}?(\d{5,8})', full_text, re.IGNORECASE)
        if not orden_match:
            orden_match = re.search(r'OT_(\d+)', filename, re.IGNORECASE)
        orden_no = orden_match.group(1).strip() if orden_match else ""
        
        # 2. DOMINIO (Solo la patente)
        dominio_match = re.search(r'DOMINIO:\s*([^\n\r]+)', full_text, re.IGNORECASE)
        dominio_raw = dominio_match.group(1).strip() if dominio_match else ""
        dominio = extract_patente(dominio_raw)

        # 3. Key: DOMINIO - ORDEN Nº
        key = f"{dominio} - {orden_no}" if dominio and orden_no else f"OT_{orden_no}" if orden_no else filename

        # 4. Fecha ingreso (Formato DD/MM/YYYY del documento)
        fecha_match = re.search(r'Fecha\s*ingreso:\s*(\d{1,2}/\d{1,2}/\d{4})', full_text, re.IGNORECASE)
        fecha_ingreso = fecha_match.group(1).strip() if fecha_match else ""
        
        if not fecha_ingreso:
            fecha_ingreso = datetime.datetime.now().strftime("%d/%m/%Y")

        # 5. Extract Tasks and Cierre Info strictly from Sector/Tareas tables
        clean_tasks = []
        cierre_records = []
        current_task_info = None

        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                is_sector_table = any(
                    row and len(row) >= 2 and ('Sector/Tareas' in str(row[1] or '') or '*' in str(row[0] or ''))
                    for row in table
                )
                if not is_sector_table:
                    continue

                for row in table:
                    if not row or not any(row):
                        continue
                    
                    first_cell = (row[0] or '').strip()
                    
                    if first_cell == '*' or (len(row) > 1 and 'Sector/Tareas' in str(row[1] or '')):
                        continue
                    
                    if 'Firma encargado' in first_cell or '...........................' in first_cell:
                        continue
                    
                    if first_cell.lower().startswith('observaciones:'):
                        obs_text = first_cell.split(':', 1)[1].strip()
                        if current_task_info and obs_text:
                            current_task_info['obs'] = obs_text
                        continue
                    
                    if first_cell.isdigit() and len(row) >= 2:
                        sector_task_cell = row[1] or ''
                        clean_tag, label_tag = format_sector_task(sector_task_cell)
                        clean_tasks.append(clean_tag)
                        
                        operario = ' '.join((row[2] or '').split()) if len(row) > 2 and row[2] else ''
                        inicio = ' '.join((row[3] or '').split()) if len(row) > 3 and row[3] else ''
                        fin = ' '.join((row[4] or '').split()) if len(row) > 4 and row[4] else ''
                        
                        current_task_info = {
                            'label': label_tag,
                            'operario': operario,
                            'inicio': inicio,
                            'fin': fin,
                            'obs': ''
                        }
                        cierre_records.append(current_task_info)

        clean_tasks_str = " | ".join(clean_tasks) if clean_tasks else "Sin tareas registradas"

        cierre_lines = []
        for c in cierre_records:
            has_data = bool(c['operario'] or c['inicio'] or c['fin'] or c['obs'])
            if has_data:
                parts = [c['label']]
                if c['operario']: parts.append('Op: ' + c['operario'])
                if c['inicio']: parts.append('Ini: ' + c['inicio'])
                if c['fin']: parts.append('Fin: ' + c['fin'])
                if c['obs']: parts.append('Obs: ' + c['obs'])
                cierre_lines.append(' - '.join(parts))

        cierre_str = " | ".join(cierre_lines) if cierre_lines else ""

        # 6. Extract confirmation of tasks (Columna H)
        confirmacion = extract_confirmacion(full_text)

        return {
            "filename": filename,
            "key": key,
            "fecha_ingreso": fecha_ingreso,
            "orden_no": orden_no,
            "dominio": dominio,
            "tareas": clean_tasks,
            "tareas_consolidada": clean_tasks_str,
            "cierre_records": [c for c in cierre_records if (c['operario'] or c['inicio'] or c['fin'] or c['obs'])],
            "cierre_consolidada": cierre_str,
            "tiene_cierre": bool(cierre_lines),
            "confirmacion": confirmacion
        }

class SyncItem(BaseModel):
    key: str
    fecha_ingreso: str
    orden_no: str
    dominio: str
    tareas_consolidada: str
    cierre_consolidada: Optional[str] = ""
    confirmacion: Optional[str] = ""

class SyncRequest(BaseModel):
    items: List[SyncItem]

class RegisterOTRequest(BaseModel):
    ot_numbers: List[str]

@app.get("/api/status")
def check_status():
    cred_path = get_service_account_path()
    return {
        "connected": cred_path is not None,
        "credentials_path": cred_path,
        "spreadsheet_id": SPREADSHEET_ID,
        "tab_name": TAB_NAME,
        "service_account": SERVICE_ACCOUNT_EMAIL
    }

@app.get("/api/ots-status")
def get_ots_status():
    """Consulta el estado de la carpeta otsE, descargas, seguimiento de cargadas y Google Sheets"""
    ensure_folders()
    sync_downloads_to_ot_folder()
    
    files = glob.glob(os.path.join(OT_FOLDER, "*.pdf"))
    registered = get_registered_ots()

    disk_ots = set()
    for f in files:
        m = re.search(r'OT_(\d+)', os.path.basename(f), re.IGNORECASE)
        if m:
            disk_ots.add(str(int(m.group(1))))
    
    combined = registered.union(disk_ots)
    if len(combined) > len(registered):
        save_registered_ots(combined)
        registered = combined

    cargadas = load_cargadas_tracker()
    uploaded_set = set(cargadas.keys())

    # Pendientes = descargadas que no están en el tracker de cargadas
    pending_ots = sorted(list(registered - uploaded_set), key=lambda x: int(x) if str(x).isdigit() else str(x))

    sheet_rows = 0
    try:
        client = get_gspread_client()
        ws = client.open_by_key(SPREADSHEET_ID).worksheet(TAB_NAME)
        sheet_rows = len(ws.col_values(1)) - 1
        if sheet_rows < 0: sheet_rows = 0
    except Exception:
        pass

    return {
        "ot_folder": OT_FOLDER,
        "total_pdfs_on_disk": len(files),
        "total_registered_ots": len(registered),
        "total_uploaded_ots": len(uploaded_set),
        "pending_count": len(pending_ots),
        "pending_ots": pending_ots,
        "registered_ots": sorted(list(registered), key=lambda x: int(x) if str(x).isdigit() else str(x)),
        "sheet_rows": sheet_rows
    }

@app.post("/api/upload-batch")
async def upload_batch(files: List[UploadFile] = File(...)):
    """Recibe archivos PDF remotamente (vía web o script CLI) y los almacena en otsE"""
    ensure_folders()
    saved = []
    registered = get_registered_ots()
    for f in files:
        if not f.filename.lower().endswith(".pdf"):
            continue
        dest_path = os.path.join(OT_FOLDER, f.filename)
        content = await f.read()
        with open(dest_path, "wb") as out:
            out.write(content)
        saved.append(f.filename)
        m = re.search(r'OT_(\d+)', f.filename, re.IGNORECASE)
        if m:
            registered.add(str(int(m.group(1))))
    save_registered_ots(registered)
    return {
        "success": True,
        "total_saved": len(saved),
        "files": saved
    }

@app.post("/api/register-downloaded-ots")
def register_downloaded_ots(payload: RegisterOTRequest):
    """Registra nuevos números de OT descargados en el archivo registro_ots.json"""
    registered = get_registered_ots()
    new_count = 0
    for num in payload.ot_numbers:
        clean_num = str(int(num)) if num.isdigit() else str(num).strip()
        if clean_num and clean_num not in registered:
            registered.add(clean_num)
            new_count += 1
    
    save_registered_ots(registered)
    sync_downloads_to_ot_folder()
    return {
        "success": True,
        "new_registered": new_count,
        "total_registered": len(registered)
    }

@app.post("/api/extract")
async def extract_pdf(files: List[UploadFile] = File(...)):
    results = []
    for file in files:
        content = await file.read()
        try:
            data = parse_pdf_content(content, file.filename)
            results.append(data)
        except Exception as e:
            results.append({
                "filename": file.filename,
                "error": str(e)
            })
    return {"extracted": results}

@app.post("/api/scan-local-folder")
def scan_local_folder(limit: Optional[int] = None):
    """Escanea la carpeta otsE y extrae la información de los PDFs para previsualizar (con caché delta)"""
    ensure_folders()
    sync_downloads_to_ot_folder()
    files = glob.glob(os.path.join(OT_FOLDER, "*.pdf"))
    if limit and limit > 0:
        files = files[:limit]
    
    cache = load_parsed_cache()
    cache_dirty = False
    results = []

    for fpath in files:
        fname = os.path.basename(fpath)
        mtime = os.path.getmtime(fpath)
        if fname in cache and cache[fname].get("mtime") == mtime and "data" in cache[fname]:
            results.append(cache[fname]["data"])
        else:
            try:
                with open(fpath, "rb") as f:
                    data = parse_pdf_content(f.read(), fname)
                    results.append(data)
                    cache[fname] = {"mtime": mtime, "data": data}
                    cache_dirty = True
            except Exception as e:
                results.append({
                    "filename": fname,
                    "error": str(e)
                })

    if cache_dirty:
        save_parsed_cache(cache)

    return {
        "total_files": len(files),
        "extracted": results
    }

@app.post("/api/process-folder-direct")
def process_folder_direct():
    """Procesa todos los PDFs de otsE y los sincroniza eficientemente por lotes a Google Sheets (con caché delta)"""
    ensure_folders()
    sync_downloads_to_ot_folder()
    
    files = glob.glob(os.path.join(OT_FOLDER, "*.pdf"))
    if not files:
        return {"success": False, "message": "No se encontraron archivos PDF en " + OT_FOLDER}

    cache = load_parsed_cache()
    cache_dirty = False
    items: List[SyncItem] = []
    errors = []
    disk_ots = set()

    for fpath in files:
        fname = os.path.basename(fpath)
        m = re.search(r'OT_(\d+)', fname, re.IGNORECASE)
        if m:
            disk_ots.add(str(int(m.group(1))))

        mtime = os.path.getmtime(fpath)
        if fname in cache and cache[fname].get("mtime") == mtime and "data" in cache[fname]:
            data = cache[fname]["data"]
            items.append(SyncItem(
                key=data["key"],
                fecha_ingreso=data["fecha_ingreso"],
                orden_no=data["orden_no"],
                dominio=data["dominio"],
                tareas_consolidada=data["tareas_consolidada"],
                cierre_consolidada=data.get("cierre_consolidada", ""),
                confirmacion=data.get("confirmacion", "")
            ))
        else:
            try:
                with open(fpath, "rb") as f:
                    data = parse_pdf_content(f.read(), fname)
                    cache[fname] = {"mtime": mtime, "data": data}
                    cache_dirty = True
                    items.append(SyncItem(
                        key=data["key"],
                        fecha_ingreso=data["fecha_ingreso"],
                        orden_no=data["orden_no"],
                        dominio=data["dominio"],
                        tareas_consolidada=data["tareas_consolidada"],
                        cierre_consolidada=data.get("cierre_consolidada", ""),
                        confirmacion=data.get("confirmacion", "")
                    ))
            except Exception as e:
                errors.append({"file": fname, "error": str(e)})

    if cache_dirty:
        save_parsed_cache(cache)

    combined = get_registered_ots().union(disk_ots)
    save_registered_ots(combined)

    sync_res = do_sync_to_sheets(items)
    sync_res["parse_errors"] = errors
    sync_res["total_files_scanned"] = len(files)
    return sync_res

def do_sync_to_sheets(items: List[SyncItem]) -> dict:
    client = get_gspread_client()
    spreadsheet = client.open_by_key(SPREADSHEET_ID)
    
    # Asegurar las 3 pestañas canónicas del ciclo de OTs
    sheet_names = [s.title for s in spreadsheet.worksheets()]
    if "ots" not in sheet_names:
        ws_ots = spreadsheet.add_worksheet(title="ots", rows=1000, cols=10)
    else:
        ws_ots = spreadsheet.worksheet("ots")
        
    if "ots_anteriores" not in sheet_names:
        ws_ant = spreadsheet.add_worksheet(title="ots_anteriores", rows=2000, cols=10)
    else:
        ws_ant = spreadsheet.worksheet("ots_anteriores")
        
    if "HISTORICO_COLD" not in sheet_names:
        ws_cold = spreadsheet.add_worksheet(title="HISTORICO_COLD", rows=3000, cols=10)
    else:
        ws_cold = spreadsheet.worksheet("HISTORICO_COLD")

    # Asegurar encabezados A1:H1 en las 3 pestañas
    for ws in [ws_ots, ws_ant, ws_cold]:
        vals = ws.get_values("A1:H1")
        if not vals or len(vals) == 0 or len(vals[0]) < 8 or vals[0][0] != HEADERS[0]:
            try:
                ws.batch_clear(["A1:Z1"])
            except Exception:
                pass
            ws.update("A1:H1", [HEADERS])

    # Leer datos existentes en las 3 pestañas
    ots_all = ws_ots.get_all_values()
    ant_all = ws_ant.get_all_values()
    cold_all = ws_cold.get_all_values()

    now_ts = datetime.datetime.now().timestamp()
    cutoff_ts = now_ts - SIX_MONTHS_SECONDS

    # 1. Mapeo de OTs en HISTORICO_COLD (> 6 meses): (clean_dom, clean_ot) -> row_index
    cold_map = {}
    for idx, r in enumerate(cold_all[1:]):
        if len(r) >= 4:
            d = normalize_plate(r[3])
            o = normalize_ot(r[2])
            if d and o:
                cold_map[(d, o)] = idx + 2

    # 2. Mapeo de OTs en ots_anteriores (<= 6 meses): (clean_dom, clean_ot) -> row_index
    ant_map = {}
    for idx, r in enumerate(ant_all[1:]):
        if len(r) >= 4:
            d = normalize_plate(r[3])
            o = normalize_ot(r[2])
            if d and o:
                ant_map[(d, o)] = idx + 2

    # 3. Mapeo de OTs vigentes en 'ots' (Col D Única): clean_dom -> (row_index, row_values)
    ots_by_dom = {}
    for idx, r in enumerate(ots_all[1:]):
        if len(r) >= 4:
            d = normalize_plate(r[3])
            if d:
                ots_by_dom[d] = (idx + 2, r)

    cargadas = load_cargadas_tracker()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for (d, o) in cold_map:
        if o not in cargadas:
            cargadas[o] = {"ot": o, "dominio": d, "estado": "HISTORICO_COLD", "fecha_carga": now_str}
    for (d, o) in ant_map:
        if o not in cargadas:
            cargadas[o] = {"ot": o, "dominio": d, "estado": "OTS_ANTERIORES", "fecha_carga": now_str}
    for d, (idx, r) in ots_by_dom.items():
        o = normalize_ot(r[2]) if len(r) > 2 else ""
        if o and o not in cargadas:
            cargadas[o] = {"ot": o, "dominio": d, "estado": "CARGADA_EN_OTS", "fecha_carga": now_str}

    ots_batch_updates = []
    ots_to_append = []
    ant_to_append = []
    cold_to_append = []

    inserted_count = 0
    updated_count = 0
    superseded_count = 0
    skipped_count = 0

    for item in items:
        clean_dom = normalize_plate(item.dominio)
        clean_ot = normalize_ot(item.orden_no)
        if not clean_dom or not clean_ot:
            continue

        item_row = [
            item.key,
            item.fecha_ingreso,
            clean_ot.zfill(8),
            clean_dom,
            item.tareas_consolidada,
            item.cierre_consolidada or "",
            "",
            item.confirmacion or ""
        ]
        item_score = parse_date_score(item.fecha_ingreso, clean_ot)

        # Regla 1: Si ya está en HISTORICO_COLD, NO se reinyecta
        if (clean_dom, clean_ot) in cold_map:
            if clean_ot not in cargadas:
                cargadas[clean_ot] = {"ot": clean_ot, "dominio": clean_dom, "estado": "HISTORICO_COLD", "fecha_carga": now_str}
            skipped_count += 1
            continue

        # Regla 2: Si ya está en ots_anteriores, NO se reinyecta a 'ots'
        if (clean_dom, clean_ot) in ant_map:
            if clean_ot not in cargadas:
                cargadas[clean_ot] = {"ot": clean_ot, "dominio": clean_dom, "estado": "OTS_ANTERIORES", "fecha_carga": now_str}
            skipped_count += 1
            continue

        # Regla 3: Clasificación en 'ots'
        if clean_dom in ots_by_dom:
            cur_idx, cur_row = ots_by_dom[clean_dom]
            cur_ot = normalize_ot(cur_row[2]) if len(cur_row) > 2 else ""

            if cur_ot == clean_ot:
                # Misma OT: actualizar en su fila (preservando datos existentes si vienen vacíos)
                if not item.cierre_consolidada and len(cur_row) >= 6 and cur_row[5]:
                    item_row[5] = cur_row[5]
                if len(cur_row) >= 7 and cur_row[6]:
                    item_row[6] = cur_row[6]
                if not item.confirmacion and len(cur_row) >= 8 and cur_row[7]:
                    item_row[7] = cur_row[7]

                ots_batch_updates.append({
                    'range': f'A{cur_idx}:H{cur_idx}',
                    'values': [item_row]
                })
                updated_count += 1
                cargadas[clean_ot] = {
                    "ot": clean_ot,
                    "dominio": clean_dom,
                    "estado": "CARGADA_EN_OTS",
                    "fecha_carga": now_str,
                    "confirmacion": item.confirmacion or ""
                }
            else:
                cur_score = parse_date_score(cur_row[1] if len(cur_row) > 1 else "", cur_ot)
                if item_score >= cur_score:
                    # La entrante es más actual: desplaza la anterior
                    if cur_score > 0 and cur_score < cutoff_ts:
                        cold_to_append.append(cur_row)
                        cold_map[(clean_dom, cur_ot)] = len(cold_all) + len(cold_to_append)
                        cargadas[cur_ot] = {"ot": cur_ot, "dominio": clean_dom, "estado": "HISTORICO_COLD", "fecha_carga": now_str}
                    else:
                        ant_to_append.append(cur_row)
                        ant_map[(clean_dom, cur_ot)] = len(ant_all) + len(ant_to_append)
                        cargadas[cur_ot] = {"ot": cur_ot, "dominio": clean_dom, "estado": "OTS_ANTERIORES", "fecha_carga": now_str}

                    ots_batch_updates.append({
                        'range': f'A{cur_idx}:H{cur_idx}',
                        'values': [item_row]
                    })
                    ots_by_dom[clean_dom] = (cur_idx, item_row)
                    superseded_count += 1
                    cargadas[clean_ot] = {
                        "ot": clean_ot,
                        "dominio": clean_dom,
                        "estado": "CARGADA_EN_OTS",
                        "fecha_carga": now_str,
                        "confirmacion": item.confirmacion or ""
                    }
                else:
                    # La entrante es más vieja que la que está vigente en 'ots'
                    if item_score > 0 and item_score < cutoff_ts:
                        cold_to_append.append(item_row)
                        cold_map[(clean_dom, clean_ot)] = len(cold_all) + len(cold_to_append)
                        cargadas[clean_ot] = {"ot": clean_ot, "dominio": clean_dom, "estado": "HISTORICO_COLD", "fecha_carga": now_str}
                    else:
                        ant_to_append.append(item_row)
                        ant_map[(clean_dom, clean_ot)] = len(ant_all) + len(ant_to_append)
                        cargadas[clean_ot] = {"ot": clean_ot, "dominio": clean_dom, "estado": "OTS_ANTERIORES", "fecha_carga": now_str}
                    skipped_count += 1
        else:
            # Dominio nuevo: agregar a 'ots'
            ots_to_append.append(item_row)
            new_idx = len(ots_all) + len(ots_to_append)
            ots_by_dom[clean_dom] = (new_idx, item_row)
            inserted_count += 1
            cargadas[clean_ot] = {
                "ot": clean_ot,
                "dominio": clean_dom,
                "estado": "CARGADA_EN_OTS",
                "fecha_carga": now_str,
                "confirmacion": item.confirmacion or ""
            }

    # Ejecutar actualizaciones en 'ots'
    if ots_batch_updates:
        for i in range(0, len(ots_batch_updates), 100):
            ws_ots.batch_update(ots_batch_updates[i:i+100])

    if ots_to_append:
        start_r = len(ots_all) + 1
        for i in range(0, len(ots_to_append), 50):
            chunk = ots_to_append[i:i+50]
            chunk_start = start_r + i
            chunk_end = chunk_start + len(chunk) - 1
            ws_ots.update(range_name=f"A{chunk_start}:H{chunk_end}", values=chunk)

    if ant_to_append:
        start_r = len(ant_all) + 1
        for i in range(0, len(ant_to_append), 50):
            chunk = ant_to_append[i:i+50]
            chunk_start = start_r + i
            chunk_end = chunk_start + len(chunk) - 1
            ws_ant.update(range_name=f"A{chunk_start}:H{chunk_end}", values=chunk)

    if cold_to_append:
        start_r = len(cold_all) + 1
        for i in range(0, len(cold_to_append), 50):
            chunk = cold_to_append[i:i+50]
            chunk_start = start_r + i
            chunk_end = chunk_start + len(chunk) - 1
            ws_cold.update(range_name=f"A{chunk_start}:H{chunk_end}", values=chunk)

    save_cargadas_tracker(cargadas)

    return {
        "success": True,
        "inserted_ots": inserted_count,
        "updated_ots": updated_count,
        "superseded_moved": superseded_count,
        "already_archived_skipped": skipped_count,
        "total_processed": len(items),
        "sheet_url": f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit"
    }

@app.get("/api/ots/cold-storage/download")
def download_cold_storage():
    """Descarga todas las OTs archivadas en HISTORICO_COLD en formato CSV"""
    client = get_gspread_client()
    spreadsheet = client.open_by_key(SPREADSHEET_ID)
    try:
        ws_cold = spreadsheet.worksheet("HISTORICO_COLD")
        all_vals = ws_cold.get_all_values()
    except Exception:
        all_vals = [HEADERS]

    csv_lines = []
    for row in all_vals:
        line = ";".join([f'"{str(c).replace(chr(34), chr(34)+chr(34))}"' for c in row])
        csv_lines.append(line)
    
    csv_content = "\ufeff" + "\n".join(csv_lines)
    return HTMLResponse(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=ots_historico_cold.csv"}
    )

@app.post("/api/ots/cold-storage/clear")
def clear_cold_storage():
    """Limpia las filas de HISTORICO_COLD manteniendo los encabezados A1:H1"""
    client = get_gspread_client()
    spreadsheet = client.open_by_key(SPREADSHEET_ID)
    try:
        ws_cold = spreadsheet.worksheet("HISTORICO_COLD")
        max_rows = ws_cold.row_count
        if max_rows > 1:
            ws_cold.batch_clear([f"A2:H{max_rows}"])
        return {"success": True, "message": "Pestaña HISTORICO_COLD limpiada exitosamente"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post("/api/sync-sheets")
def sync_to_sheets(payload: SyncRequest):
    return do_sync_to_sheets(payload.items)

# Serve static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/")
def serve_index():
    index_file = os.path.join(static_dir, "index.html")
    with open(index_file, "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())

def find_available_port(preferred_ports=[8000, 8080, 8050, 5000, 8888]):
    custom_port = os.environ.get("PORT")
    if custom_port and custom_port.isdigit():
        preferred_ports = [int(custom_port)] + [p for p in preferred_ports if p != int(custom_port)]
    for port in preferred_ports:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(('127.0.0.1', port))
            s.listen(1)
            s.close()
            return port
        except OSError:
            continue
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port

if __name__ == "__main__":
    import uvicorn
    ensure_folders()
    sync_downloads_to_ot_folder()
    selected_port = find_available_port()
    print(f"\n==========================================")
    print(f" Servidor iniciado en http://localhost:{selected_port}")
    print(f" Carpeta de OTs: {OT_FOLDER}")
    print(f"==========================================\n")
    try:
        webbrowser.open(f"http://localhost:{selected_port}")
    except Exception:
        pass
    uvicorn.run(app, host="127.0.0.1", port=selected_port)