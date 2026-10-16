"""Adapted from AgentHub core/email.py: standard-library encrypted SMTP.

Secrets arrive via stdin, never command arguments, process environment or logs.
Remote submission always uses TLS, including when SMTP does not require login.
"""
import json
import smtplib
import ssl
import sys
from email.message import EmailMessage


def send(config, content):
    message = EmailMessage()
    message["Subject"] = content["subject"]
    message["From"] = config["from"]
    message["To"] = content["to"]
    message.set_content(content["text"])
    context = ssl.create_default_context()
    if config["port"] == 465:
        connection = smtplib.SMTP_SSL(config["host"], config["port"], timeout=15, context=context)
    else:
        connection = smtplib.SMTP(config["host"], config["port"], timeout=15)
        connection.ehlo()
        connection.starttls(context=context)
        connection.ehlo()
    with connection:
        if config.get("username"):
            connection.login(config["username"], config.get("password", ""))
        connection.send_message(message)


if __name__ == "__main__":
    try:
        data = json.loads(sys.stdin.buffer.read(16385))
        send(data["config"], data["message"])
    except Exception:
        sys.exit(1)
