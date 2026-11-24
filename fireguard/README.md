# FireGuard Monitor (Flask + pyserial)

A lightweight, real-time web dashboard for an Arduino fire and gas safety system. Python reads the Arduino USB serial stream in a background thread, computes states and events, logs telemetry to CSV files, and serves a fast Chart.js dashboard over HTTP.

## Project Structure

```text
fireguard/
  app.py                # Flask server, serial reader thread, CSV logger, REST API
  requirements.txt      # Python dependencies (flask, pyserial)
  README.md             # Setup and usage instructions
  templates/
    index.html          # Dashboard HTML layout
  static/
    style.css           # Control-room styles, themes, and print stylesheet
    app.js              # Polling loop, SVG gauges, Chart.js updates, audio alerts
  data/                 # Auto-created at runtime for readings.csv, events.csv, settings.json
```

## 1. Install Dependencies

Python 3.9+ is recommended. From inside the `fireguard/` directory:

```bash
cd fireguard
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS / Linux:
# source venv/bin/activate

pip install -r requirements.txt
```

## 2. Find Your Arduino COM / Serial Port

- **Windows**: Open **Device Manager** → expand **Ports (COM & LPT)** → look for `Arduino Uno (COM3)`, `USB-SERIAL CH340 (COM4)`, etc.
- **macOS**: Run `ls /dev/cu.usb*` in Terminal (e.g., `/dev/cu.usbmodem14101`).
- **Linux**: Run `ls /dev/ttyACM* /dev/ttyUSB*` in Terminal (e.g., `/dev/ttyACM0` or `/dev/ttyUSB0`).

> **Note**: Close the Arduino IDE Serial Monitor before starting `app.py`, because only one program can access the serial port at a time.

You can also omit `--port` and let `app.py` list all detected ports and auto-select the Arduino port.

## 3. Run the Server

### With an Arduino connected (auto-detect port)
```bash
python app.py
```

### With a specific serial port and baud rate
```bash
python app.py --port COM3 --baud 115200
```
*(On macOS/Linux, replace `COM3` with e.g. `/dev/ttyACM0` or `/dev/cu.usbmodem14101`.)*

### Without hardware (Demo simulation mode)
```bash
python app.py --demo
```

### Optional server flags
```bash
python app.py --port COM3 --baud 115200 --host 0.0.0.0 --web-port 5000
```

## 4. Open the Dashboard

- **On the same PC**: Open your browser to `http://localhost:5000`
- **From a phone or tablet on the same Wi-Fi**:
  1. Find your PC's local IP address (`ipconfig` on Windows, `ifconfig` or `ip a` on macOS/Linux, e.g., `192.168.1.42`).
  2. Allow port `5000` through your OS firewall if prompted.
  3. Open `http://<PC-IP>:5000` (for example `http://192.168.1.42:5000`) on your phone's browser.

## Expected Arduino Serial Format

Startup lines (optional):
```text
Warm-up: 45s
Baseline: 280 | Threshold: 380
FIREGUARD READY
```

Live telemetry lines:
```text
MQ2: 312 | GAS: NORMAL | IR: NORMAL | SERVO: 90 | MIST: OFF | ALARM: CLEAR
```
