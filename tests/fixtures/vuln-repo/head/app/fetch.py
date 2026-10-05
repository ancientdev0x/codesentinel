import requests

def download_data(url):
    return requests.get(url, verify=False, timeout=10).text
