"""Configure the site's own email sender; no mail sent or credentials printed."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid


def existing_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        details = os.fstat(fd)
        if (not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid()
                or details.st_mode & 0o077 or details.st_nlink != 1 or details.st_size > 16384):
            raise ValueError("已有邮件设置的保护状态异常，未修改。")
        return details, os.read(fd, 16385)
    finally:
        os.close(fd)


def write_private(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def save_config(target, config, *, replace=False):
    original = existing_private(target) if replace else None
    content = (json.dumps(config, ensure_ascii=False) + "\n").encode()
    if not replace:
        write_private(target, content)
        return
    previous, data = original
    token = uuid.uuid4().hex
    backup = target.with_name("account-mail.before-" + token + ".json")
    temporary = target.with_name("account-mail." + token + ".tmp")
    write_private(backup, data)
    write_private(temporary, content)
    current, current_data = existing_private(target)
    if ((current.st_dev, current.st_ino, current.st_mtime_ns) !=
            (previous.st_dev, previous.st_ino, previous.st_mtime_ns) or current_data != data):
        temporary.unlink()
        raise ValueError("填写期间邮件设置已经变化，未覆盖；原设置备份保留。")
    os.replace(temporary, target)
    fd = os.open(target.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def prompt_config():
    provider = input("发件方式（smtp / resend）：").strip().lower()
    sender = input("发件邮箱（Resend需使用已验证域名下的地址，不是收件邮箱）：").strip()
    if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", sender):
        raise ValueError("请填写正确的发件邮箱。")
    config = {"provider": provider, "from": sender}
    if provider == "resend":
        config["apiKey"] = getpass.getpass("Resend访问密钥（re_开头，粘贴不显示）：").strip()
        if not re.fullmatch(r"re_[A-Za-z0-9_-]+", config["apiKey"]):
            raise ValueError("请复制Resend后台完整的发信密钥，未保存。")
        if sender.rsplit("@", 1)[1].lower() in {"qq.com", "163.com", "126.com", "gmail.com", "outlook.com", "hotmail.com", "icloud.com"}:
            raise ValueError("Resend发件邮箱需使用你已验证的域名；QQ等个人邮箱可以作为收件邮箱。")
    elif provider == "smtp":
        config["host"] = input("邮件服务器地址（例如 smtp.example.com）：").strip()
        config["port"] = int(input("加密端口（465 / 587 / 2525）：").strip())
        if config["port"] not in (465, 587, 2525) or not re.fullmatch(r"[A-Za-z0-9.-]+", config["host"]):
            raise ValueError("请使用正确的邮件服务器和加密邮件端口。")
        config["username"] = input("发件账号：").strip()
        config["password"] = getpass.getpass("邮件授权码（不显示，不是网站登录密码）：")
        if not config["username"] or not config["password"]:
            raise ValueError("邮件设置不完整，未保存。")
    else:
        raise ValueError("请选择smtp或resend。")
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--replace", action="store_true", help="备份现有私有设置后更正，不发送邮件")
    args = parser.parse_args()
    root = args.directory.expanduser().absolute()
    if not root.is_dir() or root.is_symlink() or not (root / "connection.json").is_file():
        raise ValueError("没有找到这份工作台，请核对资料文件夹。")
    target = root / "account-mail.json"
    if args.replace:
        existing_private(target)
    elif target.exists():
        raise ValueError("已有邮件设置，未覆盖；更正时请加 --replace，原设置会私有备份。")
    save_config(target, prompt_config(), replace=args.replace)
    print("发件邮箱已保存。没有发送邮件，请回到网页注册时获取验证码。")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        if isinstance(error, ValueError):
            print(str(error), file=sys.stderr)
        else:
            print("设置未能完成，请核对资料文件夹；已有设置不会被直接覆盖。", file=sys.stderr)
        sys.exit(1)
