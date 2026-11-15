// A seccomp filter, assembled by hand so the cage needs no compiler and no
// dependency. It does one thing: refuse the two ioctls that let a process
// type into the terminal it shares with you (TIOCSTI) or paste into it
// (TIOCLINUX). Without it the cage would have to cut the agent off from the
// terminal altogether, and a full-screen agent would no longer see resizes.
import os from 'node:os';

const ARCH = {
  x64: { audit: 0xc000003e, ioctl: 16, x32: true },
  arm64: { audit: 0xc00000b7, ioctl: 29 },
};
const TIOCSTI = 0x5412, TIOCLINUX = 0x541c;
const ALLOW = 0x7fff0000, ERRNO = 0x00050000, EPERM = 1, ENOSYS = 38;
// struct seccomp_data: nr at 0, arch at 4, args[1] at 24 (low half first: little-endian only).
const LD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06;

export function ttyFilter(arch = process.arch) {
  const a = ARCH[arch];
  if (!a || os.endianness() !== 'LE') return null;
  const prog = [
    [LD, 0, 0, 4],
    [JEQ, 1, 0, a.audit],
    // A foreign ABI numbers its system calls differently: nothing to match on.
    [RET, 0, 0, ERRNO | ENOSYS],
    [LD, 0, 0, 0],
    ...(a.x32 ? [[JGE, 0, 1, 0x40000000], [RET, 0, 0, ERRNO | ENOSYS]] : []),
    [JEQ, 0, 4, a.ioctl],
    // The kernel reads the request as 32 bits, so that is what is compared.
    [LD, 0, 0, 24],
    [JEQ, 1, 0, TIOCSTI],
    [JEQ, 0, 1, TIOCLINUX],
    [RET, 0, 0, ERRNO | EPERM],
    [RET, 0, 0, ALLOW],
  ];
  const buf = Buffer.alloc(prog.length * 8);
  prog.forEach(([code, jt, jf, k], i) => {
    buf.writeUInt16LE(code, i * 8); buf.writeUInt8(jt, i * 8 + 2); buf.writeUInt8(jf, i * 8 + 3); buf.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return buf;
}
