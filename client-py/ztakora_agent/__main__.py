import sys

from .cli import main
from .errors import ClientError


def entry():
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
    except ClientError as err:
        # This line reaches a console the device user can see, so it is a disclosure surface:
        # report the failure, never a payload.
        sys.stderr.write(f"agent error: {err.code} {str(err.detail or '')[:200]}\n")
        sys.exit(1)
    except Exception as err:
        sys.stderr.write(f"agent error: {getattr(err, 'code', None) or 'internal'} "
                         f"{str(err)[:200]}\n")
        sys.exit(1)


if __name__ == "__main__":
    entry()
