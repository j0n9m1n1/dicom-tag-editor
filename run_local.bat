@echo off
echo Starting DICOM Tag Editor locally on http://localhost:8080 ...
start "" http://localhost:8080
python -m http.server 8080
