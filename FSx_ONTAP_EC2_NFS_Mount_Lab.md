# Lab Guide: Mount Amazon FSx for NetApp ONTAP NFS Volume on Ubuntu EC2

**Audience:** L1 / L1.5 storage support engineers  
**Goal:** Mount an existing ONTAP FlexVol from one or more Ubuntu EC2 instances using NFSv4.1; verify access and troubleshoot common failures.

## 1. Lab environment

| Item | Value |
|---|---|
| AWS Region | `us-east-1` |
| VPC | `vpc-08dcd097ceb7bbb95` |
| FSx file system ID | `fs-0ccfa8c64e72e3695` |
| SVM ID | `svm-0efbdc01b28f2954a` |
| SVM NFS endpoint IP | `172.31.92.37` |
| SVM NFS DNS | `svm-0efbdc01b28f2954a.fs-0ccfa8c64e72e3695.fsx.us-east-1.amazonaws.com` |
| Existing EC2 private IP | `172.31.43.59` |
| ONTAP volume | `demovol1` |
| Volume junction path | `/vol1` |
| Linux mount directory | `/mnt/ontap` |
| NFS protocol | NFSv4.1 over TCP 2049 |

> **Do not use the file-system management IP (`172.31.95.5`) or the SVM management IP (`172.31.92.37` happens to be listed as both management and NFS in this particular SVM) based solely on its management role.** Use the **NFS endpoint** from **FSx → Storage virtual machines → SVM → Endpoints**. In this lab, the NFS endpoint IP shown is `172.31.92.37`.

## 2. Architecture

```text
Ubuntu EC2-1 (172.31.43.59)         Ubuntu EC2-2 (optional)
          |                                     |
          |       NFSv4.1 / TCP 2049           |
          +------------------+------------------+
                             |
                      AWS VPC networking
                             |
                             v
                  FSx for NetApp ONTAP
                             |
                  SVM NFS endpoint (LIF)
                       172.31.92.37
                             |
                       SVM namespace
                             |
                   /vol1 → demovol1
                             |
                   Shared files/directories
```

An **SVM** is a logical storage server running within ONTAP. A **volume** is a data container inside the SVM. The **junction path** (`/vol1`) makes that volume available in the SVM's NFS namespace. EC2 mounts the exported path; it does **not** attach the FlexVol as an EBS block device.

## 3. Prerequisites

1. FSx file system and SVM show **Available** in AWS.
2. `demovol1` exists, is online, and is mounted at junction path `/vol1` in the SVM namespace.
3. NFS service is enabled on the SVM, and the applicable export policies permit the EC2 client's IP and NFSv4 access.
4. EC2 can route to the SVM NFS endpoint (same VPC or connected network).
5. FSx network-interface security groups allow **inbound TCP 2049** from the EC2 security group or approved EC2 CIDR. EC2 security group allows **outbound TCP 2049**. NACLs permit traffic and return traffic.
6. You have `sudo` privileges on Ubuntu. No ONTAP administrator username is used in the NFS mount command.

### Find the FSx network interface security groups

AWS Console: **FSx → File systems → select file system → Network & security**, and **EC2 → Network Interfaces** to inspect the interfaces belonging to the FSx file system and their attached security groups. Do not assume the EC2 security group is also the FSx security group.

Optional AWS CLI (requires IAM permissions):

```bash
aws fsx describe-file-systems \
  --file-system-ids fs-0ccfa8c64e72e3695 \
  --region us-east-1 \
  --query 'FileSystems[0].NetworkInterfaceIds' --output json

aws ec2 describe-network-interfaces \
  --network-interface-ids <ENI_ID_FROM_ABOVE> \
  --region us-east-1 \
  --query 'NetworkInterfaces[*].{ID:NetworkInterfaceId,Groups:Groups,IP:PrivateIpAddress}'
```

## 4. Connect to your existing Ubuntu EC2

Use EC2 Instance Connect / Session Manager where supported, or SSH from an authorized host:

```bash
ssh -i <KEY_FILE.pem> ubuntu@<EC2_PUBLIC_IP_OR_REACHABLE_DNS>
```

The `ubuntu@` username is for **SSH to Ubuntu**, not for NFS.

Confirm the instance's private address and route:

```bash
hostname -I
ip route get 172.31.92.37
```

## 5. Install the NFS client

```bash
sudo apt update
sudo apt install -y nfs-common
mount.nfs -V
```

## 6. Test DNS and network connectivity **before mounting**

```bash
# Resolve the SVM NFS endpoint
getent hosts svm-0efbdc01b28f2954a.fs-0ccfa8c64e72e3695.fsx.us-east-1.amazonaws.com

# Confirm NFS TCP 2049 is reachable (install netcat-openbsd if nc is absent)
nc -zv -w 5 172.31.92.37 2049
```

Expected: a `succeeded` or `open` message. A **timeout** usually indicates security-group, NACL, or routing issues; do not repeatedly run a mount that hangs before addressing connectivity.

## 7. Create the mount directory

```bash
sudo mkdir -p /mnt/ontap
ls -ld /mnt/ontap
```

## 8. Mount the ONTAP volume using NFSv4.1

Use the **NFS endpoint DNS** (preferred):

```bash
sudo mount -t nfs -o vers=4.1,proto=tcp \
  svm-0efbdc01b28f2954a.fs-0ccfa8c64e72e3695.fsx.us-east-1.amazonaws.com:/vol1 \
  /mnt/ontap
```

Or use its IP:

```bash
sudo mount -t nfs -o vers=4.1,proto=tcp \
  172.31.92.37:/vol1 \
  /mnt/ontap
```

A successful `mount` typically prints **nothing** and returns to the shell prompt. **Do not include `username@`** in the NFS server path.

## 9. Verify mount and file access

```bash
findmnt /mnt/ontap
df -hT /mnt/ontap
nfsstat -m
ls -la /mnt/ontap
```

Create a test file using your normal Linux user:

```bash
printf 'NFS lab from %s at %s\n' "$(hostname)" "$(date -Is)" > /mnt/ontap/ec2-test.txt
cat /mnt/ontap/ec2-test.txt
```

If writing fails with `Permission denied`, inspect export-policy rules, root-squash behavior, and file UID/GID permissions. `sudo` is **not** guaranteed to bypass NFS permissions.

## 10. Mount the same volume on a second EC2 (optional)

On EC2-2, repeat steps 4–8 using the **same** server path and a local mount directory of your choice:

```bash
sudo apt update && sudo apt install -y nfs-common
sudo mkdir -p /mnt/ontap
nc -zv -w 5 172.31.92.37 2049
sudo mount -t nfs -o vers=4.1,proto=tcp 172.31.92.37:/vol1 /mnt/ontap
cat /mnt/ontap/ec2-test.txt
```

Both EC2 clients see the same shared files. Ensure the export policy and security groups allow **both** clients. NFS provides locking semantics, but applications must still coordinate concurrent writes to the same file.

## 11. Make the mount persistent across reboots

Only after the manual mount succeeds, back up `/etc/fstab`:

```bash
sudo cp /etc/fstab /etc/fstab.bak
```

Add this **single line** to `/etc/fstab`:

```fstab
svm-0efbdc01b28f2954a.fs-0ccfa8c64e72e3695.fsx.us-east-1.amazonaws.com:/vol1 /mnt/ontap nfs vers=4.1,proto=tcp,_netdev,nofail 0 0
```

Then test carefully (run outside the mounted directory):

```bash
cd ~
sudo umount /mnt/ontap
sudo mount -a
findmnt /mnt/ontap
```

`_netdev` identifies a network mount; `nofail` avoids treating mount failure as a fatal boot condition. For critical services, consider a systemd automount and explicit service ordering.

## 12. L1 / L1.5 troubleshooting matrix

| Symptom | First checks (Ubuntu) | Likely causes / ONTAP checks |
|---|---|---|
| `mount` hangs | `nc -zv -w 5 172.31.92.37 2049`; `ip route get 172.31.92.37` | FSx SG inbound 2049, EC2 SG outbound 2049, NACL, route |
| DNS name fails | `getent hosts <SVM_NFS_DNS>` | VPC DNS configuration, resolver, incorrect hostname |
| `access denied by server` | `sudo mount -v -t nfs -o vers=4.1 ...` | NFS service, junction path, root namespace export, volume export policy |
| `No such file or directory` | Confirm `:/vol1` spelling | Volume junction path missing or wrong; namespace traversal |
| Mount works, `touch` fails | `id`; `ls -ldn /mnt/ontap` | Export policy read-only, Unix UID/GID/mode, root squashing |
| Mounted directory empty | `findmnt /mnt/ontap`; `ls -la /mnt/ontap` | New empty volume is normal; ensure correct server and path |
| `No space left on device` | `df -hT /mnt/ontap`; `df -i /mnt/ontap` | Volume space, quotas, snapshots, inode/file limits |
| Slow I/O | `nfsstat -m`; `nfsiostat 1` (if installed); `dmesg` | Client/network latency, FSx throughput/IOPS, ONTAP volume performance |
| `Stale file handle` | `findmnt`; `dmesg` | Namespace or underlying file changes; escalate before remounting production workloads |
| `target is busy` on unmount | `sudo fuser -vm /mnt/ontap` | Open files, shells or processes using mount |

### Ubuntu diagnostic commands

```bash
# Client and routing
ip addr
ip route
ip route get 172.31.92.37
getent hosts svm-0efbdc01b28f2954a.fs-0ccfa8c64e72e3695.fsx.us-east-1.amazonaws.com
nc -zv -w 5 172.31.92.37 2049

# Mount diagnostics
findmnt /mnt/ontap
mount | grep /mnt/ontap
df -hT /mnt/ontap
nfsstat -m
sudo dmesg | tail -50
journalctl -k -n 50 --no-pager

# Permissions
id
ls -ldn /mnt/ontap
stat /mnt/ontap

# Busy mount
sudo fuser -vm /mnt/ontap
```

> `showmount -e` is primarily an NFSv3/mountd diagnostic and may fail or be misleading in an NFSv4-only environment. Do **not** use it as the deciding test for an NFSv4.1 mount.

### ONTAP CLI checks (after separately establishing administrative SSH access)

Connect to the **file-system management endpoint** using `fsxadmin` (administration is distinct from NFS data access):

```bash
ssh fsxadmin@172.31.95.5
```

At the ONTAP prompt, replace `<SVM_NAME>` with the name returned by `vserver show`:

```text
vserver show
vserver nfs show
volume show -fields vserver,volume,state,junction-path,policy
volume show -vserver <SVM_NAME> -volume demovol1
vserver export-policy show
vserver export-policy rule show -vserver <SVM_NAME>
network interface show
network route show
volume show-space -vserver <SVM_NAME> -volume demovol1
event log show
```

For export-policy evaluation, consult CLI help to confirm required arguments for your ONTAP version:

```text
vserver export-policy check-access -help
```

Use client IP `172.31.43.59`, volume `demovol1`, protocol `nfs4`, and authentication method `sys` as applicable to your environment. A successful TCP port check does **not** prove that ONTAP export policy grants mount/read/write permissions.

## 13. Unmount safely

```bash
cd ~
sudo umount /mnt/ontap
findmnt /mnt/ontap
```

If `target is busy`, identify and stop/coordinate active users before unmounting. Avoid forced or lazy unmounts on production systems without an approved procedure.

## 14. L1 / L1.5 escalation checklist

Collect the following before escalation:

- FSx file-system ID, SVM ID/name, volume name and junction path.
- EC2 instance ID, private IP, VPC, subnet, and EC2 security group ID.
- SVM NFS DNS/IP, relevant FSx security group IDs, and TCP 2049 test output.
- Exact mount command, timestamp, and full error message.
- `findmnt`, `nfsstat -m`, `ip route get`, and relevant kernel log output.
- ONTAP `vserver nfs show`, `volume show`, and export-policy output (if permitted).
- Whether the issue affects one EC2, multiple EC2s, one volume, or multiple volumes.

**Do not change** export policies, volume size, security styles, permissions, or networking on production systems without authorization and a documented rollback plan.

## 15. Official documentation

- AWS FSx for ONTAP user guide: https://docs.aws.amazon.com/fsx/latest/ONTAPGuide/what-is-fsx-ontap.html
- AWS FSx for ONTAP mounting NFS volumes: https://docs.aws.amazon.com/fsx/latest/ONTAPGuide/mounting-linux.html
- NetApp ONTAP documentation: https://docs.netapp.com/us-en/ontap/

---

**Lab success criteria:** `nc` reaches TCP 2049, `findmnt` shows the SVM export mounted at `/mnt/ontap`, `nfsstat -m` reports NFSv4.1, and a permitted user can create and read a test file. For the two-client exercise, EC2-2 can read the file created by EC2-1.
