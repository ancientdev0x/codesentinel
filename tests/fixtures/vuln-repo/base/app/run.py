import subprocess

def run_ping(host):
    return subprocess.run(["ping", "-c", "1", host], check=True)
