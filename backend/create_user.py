"""Create an EvaDE user and print a one-time personal API token.

Usage: cd backend && python create_user.py "Alice" [--admin]
"""
import hashlib
import secrets
import sys
from app.database import Base, SessionLocal, engine
from app.models import User

if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python create_user.py "User Name" [--admin]')
    Base.metadata.create_all(bind=engine)
    token = secrets.token_urlsafe(36)
    with SessionLocal() as db:
        user = User(name=sys.argv[1], token_hash=hashlib.sha256(token.encode()).hexdigest(), is_admin="--admin" in sys.argv)
        db.add(user)
        db.commit()
        print(f"User: {user.name} ({user.id})")
        print(f"Personal API token (shown once): {token}")
