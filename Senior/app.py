from contextlib import closing
from collections import deque
from flask import Flask, jsonify, render_template, request
import logging
import os
import requests
import sqlite3
import threading
import time

try:
  from smartcard.CardMonitoring import CardMonitor, CardObserver
  from smartcard.util import toHexString
  SMARTCARD_IMPORT_ERROR = None
except ImportError as error:
  CardMonitor = None
  CardObserver = object
  toHexString = None
  SMARTCARD_IMPORT_ERROR = error

app = Flask(__name__)
DB_NAME = os.path.join(app.root_path, "tools.db")
scanner_events = deque(maxlen=100)
scanner_event_lock = threading.Lock()
scanner_event_sequence = 0
reader_scan_lock = threading.Lock()
recent_reader_scans = {}
reader_scan_debounce_seconds = 0.4
reader_status = {
    "available": False,
    "message": "Reader monitor has not started",
}
reader_status_lock = threading.Lock()


def init_db():
  with closing(sqlite3.connect(DB_NAME)) as conn:
    with conn:
      conn.execute("""
          CREATE TABLE IF NOT EXISTS tools (
              tag_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              status TEXT DEFAULT 'Removed'
          )
      """)


def get_json_data():
  data = request.get_json(silent=True)
  if not isinstance(data, dict):
    return None
  return data


@app.route("/")
def index():
  return render_template("index.html")


@app.route("/api/tools", methods=["GET"])
def get_tools():
  with closing(sqlite3.connect(DB_NAME)) as conn:
    rows = conn.execute("SELECT tag_id, name, status FROM tools").fetchall()
  tools = [{"tag_id": r[0], "name": r[1], "status": r[2]} for r in rows]
  return jsonify(tools)


@app.route("/api/tools", methods=["POST"])
def add_tool():
  data = get_json_data()
  if data is None:
    return jsonify({"error": "A JSON object is required"}), 400
  tag_id = data.get("tag_id")
  name = data.get("name")
  if (
      not isinstance(tag_id, str)
      or not tag_id.strip()
      or not isinstance(name, str)
      or not name.strip()
  ):
    return jsonify({"error": "Missing tag_id or name"}), 400

  try:
    with closing(sqlite3.connect(DB_NAME)) as conn:
      with conn:
        conn.execute(
            "INSERT INTO tools (tag_id, name, status) VALUES (?, ?, 'Removed')",
            (tag_id.strip(), name.strip()),
        )
  except sqlite3.IntegrityError:
    return jsonify({"error": "A tool with this tag_id already exists"}), 409
  return jsonify({"success": True})


def scan_tag_id(tag_id):
  with closing(sqlite3.connect(DB_NAME)) as conn:
    with conn:
      conn.execute("BEGIN IMMEDIATE")
      row = conn.execute(
          "SELECT name, status FROM tools WHERE tag_id = ?", (tag_id,)
      ).fetchone()
      if row is None:
        return {"found": False}
      next_status = "Present" if row[1] == "Removed" else "Removed"
      conn.execute(
          "UPDATE tools SET status = ? WHERE tag_id = ?", (next_status, tag_id)
      )
  return {"found": True, "name": row[0], "status": next_status}


def publish_scanner_event(tag_id, result, action="scanned"):
  global scanner_event_sequence
  with scanner_event_lock:
    scanner_event_sequence += 1
    scanner_events.append({
        "id": scanner_event_sequence,
        "tag_id": tag_id,
        "action": action,
        "result": result,
    })


@app.route("/api/scan", methods=["POST"])
def scan_tag():
  data = get_json_data()
  if data is None:
    return jsonify({"error": "A JSON object is required"}), 400
  tag_id = data.get("tag_id")
  if not isinstance(tag_id, str) or not tag_id.strip():
    return jsonify({"error": "Missing tag_id"}), 400
  return jsonify(scan_tag_id(tag_id.strip()))


def set_reader_status(available, message):
  with reader_status_lock:
    reader_status.update({"available": available, "message": message})


@app.route("/api/reader/scan", methods=["POST"])
def scan_from_reader():
  data = get_json_data()
  if data is None:
    return jsonify({"error": "A JSON object is required"}), 400
  tag_id = data.get("tag_id")
  if not isinstance(tag_id, str) or not tag_id.strip():
    return jsonify({"error": "Missing tag_id"}), 400

  normalized_tag_id = tag_id.strip()
  now = time.monotonic()
  with reader_scan_lock:
    recent_scan = recent_reader_scans.get(normalized_tag_id)
    if recent_scan and now - recent_scan[0] < reader_scan_debounce_seconds:
      return jsonify(recent_scan[1])

    result = scan_tag_id(normalized_tag_id)
    recent_reader_scans[normalized_tag_id] = (now, result)
    expired_tags = [
        recent_tag_id
        for recent_tag_id, (scanned_at, _) in recent_reader_scans.items()
        if now - scanned_at >= reader_scan_debounce_seconds
    ]
    for expired_tag_id in expired_tags:
      del recent_reader_scans[expired_tag_id]

    publish_scanner_event(normalized_tag_id, result)
  return jsonify(result)


@app.route("/api/reader/remove", methods=["POST"])
def remove_from_reader():
  data = get_json_data()
  if data is None:
    return jsonify({"error": "A JSON object is required"}), 400
  tag_id = data.get("tag_id")
  if not isinstance(tag_id, str) or not tag_id.strip():
    return jsonify({"error": "Missing tag_id"}), 400

  normalized_tag_id = tag_id.strip()
  publish_scanner_event(normalized_tag_id, {"removed": True}, action="removed")
  return jsonify({"success": True})


@app.route("/api/reader/status", methods=["GET"])
def get_reader_status():
  with reader_status_lock:
    return jsonify(reader_status.copy())


@app.route("/api/reader/events", methods=["GET"])
def get_reader_events():
  try:
    after_id = int(request.args.get("after", "0"))
  except ValueError:
    return jsonify({"error": "The after parameter must be an integer"}), 400
  if after_id < 0:
    return jsonify({"error": "The after parameter must not be negative"}), 400

  with scanner_event_lock:
    events = [event for event in scanner_events if event["id"] > after_id]
  return jsonify(events)


@app.route("/api/reader/events/latest", methods=["GET"])
def get_latest_reader_event():
  with scanner_event_lock:
    return jsonify({"latest_id": scanner_event_sequence})


@app.route("/api/tools/<tag_id>", methods=["PATCH"])
def rename_tool(tag_id):
  data = get_json_data()
  if data is None:
    return jsonify({"error": "A JSON object is required"}), 400
  name = data.get("name")
  if not isinstance(name, str) or not name.strip():
    return jsonify({"error": "A tool name is required"}), 400

  with closing(sqlite3.connect(DB_NAME)) as conn:
    with conn:
      cursor = conn.execute(
          "UPDATE tools SET name = ? WHERE tag_id = ?",
          (name.strip(), tag_id),
      )
      if cursor.rowcount == 0:
        return jsonify({"error": "Tag not found in database"}), 404
  return jsonify({"success": True})


@app.route("/api/status", methods=["POST"])
def update_status():
  data = get_json_data()
  if data is None:
    return jsonify({"error": "A JSON object is required"}), 400
  tag_id = data.get("tag_id")
  status = data.get("status")
  if (
      not isinstance(tag_id, str)
      or not tag_id.strip()
      or status not in ("Present", "Removed")
  ):
    return jsonify({"error": "A valid tag_id and status are required"}), 400

  with closing(sqlite3.connect(DB_NAME)) as conn:
    with conn:
      cursor = conn.execute(
          "UPDATE tools SET status = ? WHERE tag_id = ?",
          (status, tag_id.strip()),
      )
      if cursor.rowcount == 0:
        return jsonify({"error": "Tag not found in database"}), 404
  return jsonify({"success": True})


@app.route("/api/tools/<tag_id>", methods=["DELETE"])
def delete_tool(tag_id):
  with closing(sqlite3.connect(DB_NAME)) as conn:
    with conn:
      cursor = conn.execute("DELETE FROM tools WHERE tag_id = ?", (tag_id,))
      if cursor.rowcount == 0:
        return jsonify({"error": "Tag not found in database"}), 404
  return jsonify({"success": True})


init_db()

class ACR122UListener(CardObserver):
    def __init__(self):
        super().__init__()
        self.card_tags = {}

    def update(self, observable, actions):
        added_cards, removed_cards = actions
        del observable
        for card in added_cards:
            try:
                connection = card.createConnection()
                if connection is None:
                    raise RuntimeError("Could not create a connection to the NFC reader.")
                connection.connect()
                try:
                    # Standard APDU command to get UID from an ACR122U reader
                    get_uid_command = [0xFF, 0xCA, 0x00, 0x00, 0x00]
                    data, sw1, sw2 = connection.transmit(get_uid_command)
                finally:
                    connection.disconnect()
                
                if sw1 == 0x90 and sw2 == 0x00:
                    # Format UID bytes into a clean string
                    tag_id = toHexString(data).replace(" ", "").upper()
                    print(f"\n[NFC DETECTED] Tag ID: {tag_id}")
                    self.card_tags[card] = tag_id
                    
                    # Send the scanned Tag ID to your running Flask website API
                    try:
                        response = requests.post(
                            'http://127.0.0.1:5000/api/reader/scan',
                            json={'tag_id': tag_id},
                            timeout=5,
                        )
                        response.raise_for_status()
                        print("[API SYNC] Server response:", response.json())
                        set_reader_status(True, "NFC reader is monitoring for tags")
                    except requests.RequestException:
                        set_reader_status(False, "Flask could not receive the NFC scan")
                        logging.exception(
                            "Could not send NFC scan to Flask; is the server running?"
                        )
                else:
                    print("[WARNING] Failed to read tag UID.")
            except Exception:
                logging.exception("Card communication error while reading NFC tag.")
        for card in removed_cards:
            tag_id = self.card_tags.pop(card, None)
            if tag_id is None:
                continue
            try:
                response = requests.post(
                    'http://127.0.0.1:5000/api/reader/remove',
                    json={'tag_id': tag_id},
                    timeout=5,
                )
                response.raise_for_status()
                print(f"[NFC REMOVED] Tag ID: {tag_id}")
            except requests.RequestException:
                logging.exception("Could not send NFC tag removal to Flask.")

if __name__ == "__main__":
    print("==================================================")
    print(" ACR122U Background NFC Listener Active")
    print(" Tap your tool tags on the reader...")
    print("==================================================")
    
    cardmonitor = None
    observer = None
    if CardMonitor is None:
        set_reader_status(False, "pyscard is unavailable; install the requirements")
        logging.error("Could not start the NFC reader: %s", SMARTCARD_IMPORT_ERROR)
    else:
        try:
            cardmonitor = CardMonitor()
            observer = ACR122UListener()
            cardmonitor.addObserver(observer)
            set_reader_status(True, "NFC reader is monitoring for tags")
        except Exception:
            set_reader_status(False, "NFC reader unavailable; check its driver and connection")
            logging.exception("Could not start the PC/SC NFC reader")

    try:
        app.run(debug=True, port=5000, use_reloader=False, threaded=True)
    except KeyboardInterrupt:
        pass
    finally:
        if cardmonitor is not None and observer is not None:
            cardmonitor.deleteObserver(observer)
        print("\nNFC listener stopped.")