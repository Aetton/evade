"""One-time administrator bootstrap, safe to rerun.

Prints the token only when the first admin is created. Never resets a token.
"""
import hashlib
import os
import secrets
from sqlalchemy import select
from app.database import Base, SessionLocal, engine
from app.models import User

def main():
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        admin = db.scalar(select(User).where(User.is_admin.is_(True)).limit(1))
        if admin is not None:
            print("EXISTING_ADMIN")
            return
        token = secrets.token_urlsafe(48)
        db.add(User(name=os.getenv("EVADE_ADMIN_NAME", "admin"), is_admin=True,
                    token_hash=hashlib.sha256(token.encode()).hexdigest()))
        db.commit()
        print("CREATED_ADMIN_TOKEN=" + token)

if __name__ == "__main__":
    main()
