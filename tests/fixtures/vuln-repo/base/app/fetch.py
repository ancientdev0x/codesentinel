import requests

def download_data(url):
    return requests.get(url, verify=True, timeout=10).text
