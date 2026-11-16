# Local preview only (started by scripts/preview.mjs): runs NexusBackend's real mail service,
# with a stand-in SMTP relay that records messages instead of sending them. Never deployed.
import sys

sys.path.insert(0, sys.argv[1])  # path to NexusBackend/mail
import server  # noqa: E402


class RecordingRelay:
    def starttls(self, context=None): pass
    def login(self, user, password): pass
    def quit(self): pass

    def send_message(self, msg, from_addr, to_addrs):
        print(f'preview relay: not sent, would deliver "{msg["Subject"]}" to {len(to_addrs)} recipient(s)', file=sys.stderr)


_init = server.Mailer.__init__
server.Mailer.__init__ = lambda self, store, env, smtp_factory=None: _init(self, store, env, smtp_factory=RecordingRelay)
server.main()
