# -*- coding: utf-8 -*-
"""
Herramienta CLI para sincronizar OTs locales a la nube (Render) o a localhost.
Permite subir los PDFs descargados en disco a la instancia remota del Extractor
y disparar la actualizacion en Google Sheets sin necesidad de mantener la PC encendida.
"""

import os
import sys
import glob
import re
import json
import argparse
import urllib.request
import urllib.parse
import mimetypes
import uuid

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEFAULT_LOCAL_URL = "http://localhost:8000"
DEFAULT_FOLDER = r"C:\Users\Matias Rodriguez\Documents\docs\otsE"

def post_multipart(url, files):
    boundary = uuid.uuid4().hex
    body = bytearray()
    for file_path in files:
        filename = os.path.basename(file_path)
        mime = mimetypes.guess_type(file_path)[0] or "application/pdf"
        with open(file_path, "rb") as f:
            content = f.read()
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'.encode("utf-8"))
        body.extend(f"Content-Type: {mime}\r\n\r\n".encode("utf-8"))
        body.extend(content)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))
    req = urllib.request.Request(
        url,
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": "OT-Sync-Agent/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read().decode("utf-8"))

def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "OT-Sync-Agent/1.0"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))

def post_json(url, payload=None):
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "OT-Sync-Agent/1.0"}
    )
    with urllib.request.urlopen(req, timeout=180) as res:
        return json.loads(res.read().decode("utf-8"))

def main():
    parser = argparse.ArgumentParser(description="Sincronizador de OTs a Extractor Cloud / Local")
    parser.add_argument("--url", default=os.environ.get("EXTRACTOR_URL", DEFAULT_LOCAL_URL), help="URL base del extractor")
    parser.add_argument("--folder", default=os.environ.get("OT_FOLDER", DEFAULT_FOLDER), help="Carpeta local de PDFs")
    parser.add_argument("--batch-size", type=int, default=30, help="Tamanio de lote")
    args = parser.parse_args()

    base_url = args.url.rstrip("/")
    folder = args.folder

    print("=" * 60)
    print(f"   SINCRONIZADOR DE OTs - TALLER & EXTRACCION")
    print(f"   Destino: {base_url}")
    print(f"   Carpeta: {folder}")
    print("=" * 60)

    if not os.path.isdir(folder):
        print(f"[!] Error: La carpeta {folder} no existe.")
        sys.exit(1)

    all_pdfs = glob.glob(os.path.join(folder, "*.pdf"))
    print(f"[+] PDFs encontrados en disco: {len(all_pdfs)}")

    try:
        status_data = get_json(f"{base_url}/api/ots-status")
        print(f"[*] Estado del extractor:")
        print(f"   - PDFs registrados en servidor: {status_data.get('total_registered_ots', 'N/D')}")
        print(f"   - OTs cargadas en Sheets:       {status_data.get('total_uploaded_ots', 'N/D')}")
        print(f"   - OTs pendientes de carga:      {status_data.get('pending_count', 'N/D')}")
        server_registered = set(status_data.get("registered_ots", []))
    except Exception as e:
        print(f"[!] Error conectando al extractor en {base_url}: {e}")
        sys.exit(1)

    is_remote = not ("localhost" in base_url or "127.0.0.1" in base_url)
    files_to_upload = []

    if is_remote:
        print("\n[>] Detectando archivos pendientes de subida remota...")
        for fpath in all_pdfs:
            fname = os.path.basename(fpath)
            m = re.search(r"OT_(\d+)", fname, re.IGNORECASE)
            ot_id = str(int(m.group(1))) if m else fname
            if ot_id not in server_registered:
                files_to_upload.append(fpath)

        if files_to_upload:
            print(f"[^] Subiendo {len(files_to_upload)} archivo(s) a la nube...")
            for i in range(0, len(files_to_upload), args.batch_size):
                chunk = files_to_upload[i:i + args.batch_size]
                print(f"   -> Lote {i+1} a {min(i + len(chunk), len(files_to_upload))} de {len(files_to_upload)}...")
                res_upload = post_multipart(f"{base_url}/api/upload-batch", chunk)
                if not res_upload.get("success"):
                    print(f"   [!] Error subiendo lote: {res_upload}")
        else:
            print("[OK] Todos los PDFs locales ya se encuentran subidos al servidor remoto.")
    else:
        print("\n[i] Modo Local: Los PDFs ya estan disponibles directamente para el extractor local.")

    print("\n[*] Disparando procesamiento y sincronizacion hacia Google Sheets...")
    try:
        sync_result = post_json(f"{base_url}/api/process-folder-direct")
        if sync_result.get("success"):
            print("[OK] Sincronizacion completada con exito!")
            print(f"   - Total procesadas:     {sync_result.get('total_processed', 0)}")
            print(f"   - Nuevas agregadas:     {sync_result.get('inserted_ots', 0)}")
            print(f"   - Actualizadas en ots:  {sync_result.get('updated_ots', 0)}")
            print(f"   - Movidas a historico:  {sync_result.get('superseded_moved', 0)}")
            print(f"   - Ya archivadas salt.:  {sync_result.get('already_archived_skipped', 0)}")
            print(f"   - Planilla:             {sync_result.get('sheet_url', 'N/D')}")
        else:
            print(f"[!] Advertencia: {sync_result.get('message', 'Error en sincronizacion')}")
    except Exception as e:
        print(f"[!] Error al ejecutar sincronizacion en el servidor: {e}")

    print("=" * 60)

if __name__ == "__main__":
    main()
