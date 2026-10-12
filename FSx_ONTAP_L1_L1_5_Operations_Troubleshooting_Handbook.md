# Amazon FSx for NetApp ONTAP — L1 / L1.5 Operations & Troubleshooting Handbook

**Audience:** Storage operations, service desk, NOC, junior cloud/storage engineers  
**Scope:** Amazon FSx for NetApp ONTAP (AWS-managed), ONTAP CLI, SVMs, NFS, SMB, iSCSI, Linux/Windows clients, AWS networking and monitoring  
**Edition:** Training handout — October 2026  
**Operating principle:** Observe → identify fault domain → collect evidence → perform approved low-risk remediation → verify → document/escalate.

> **Safety and version note:** Command availability, exact fields and administrative privileges vary by ONTAP release, FSx deployment type and `fsxadmin`/`vsadmin` roles. Use `?`, `<command> ?`, `<command> -help`, and AWS/NetApp documentation to verify syntax in your environment. Some on-premises ONTAP commands are restricted on FSx. Examples use placeholders; never paste angle-bracket placeholders literally. This is an operations reference, not authorization to modify production.

---

## 1. Learning objectives and scope of L1/L1.5

By the end of the training, an engineer should be able to:

1. Explain **AWS FSx file system → ONTAP HA pair(s) → SVM → volume → protocol endpoint → client**.
2. Distinguish **management plane** (AWS API, ONTAP CLI) from **data plane** (NFS/SMB/iSCSI).
3. Find the correct management/SVM endpoint, security groups and volume junction path.
4. Determine whether an incident is caused by **DNS, VPC routing, security groups, NACLs, SVM services, export/share rules, client mounts, space, performance, or backend health**.
5. Collect safe evidence and identify the appropriate escalation owner.
6. Avoid high-risk commands that can delete data or interrupt services.

### Roles and change boundaries

| Activity | L1 | L1.5 | Escalate / change approval |
|---|---|---|---|
| Check AWS FSx status, CloudWatch, alarms | Yes | Yes | — |
| Run read-only ONTAP `show`, `df`, event queries | Yes | Yes | — |
| Run Linux/Windows read-only diagnostics | Yes | Yes | — |
| Validate security group/NACL/route entries | Yes | Yes | Network team for changes |
| Add security group rule | Request/approved only | Approved runbook | Network/cloud owner |
| Change export policy, SMB share ACL, iSCSI mapping | No | Approved runbook only | Storage/security owner |
| Expand volumes/file-system SSD capacity | No | Approved runbook only | Storage/cloud owner |
| Restore snapshots, delete volumes, modify HA | No | No | Senior storage engineer + change |

---

## 2. Architecture: what runs where?

### 2.1 Logical architecture

```text
                      AWS account / VPC
  +-------------------------------------------------------------+
  | EC2 Linux/Windows clients                                   |
  |   NFS 2049 | SMB 445 | iSCSI 3260                           |
  |            |                                                 |
  |            v                                                 |
  |  Amazon FSx for NetApp ONTAP file system                     |
  |  (AWS-managed ONTAP infrastructure, SSD capacity, throughput)|
  |    +----------------------------------------------------+   |
  |    | ONTAP nodes (HA pair; number varies by deployment) |   |
  |    |  ONTAP storage services / data processing          |   |
  |    |                                                    |   |
  |    | SVM: svm-prod              SVM: svm-dev             |   |
  |    |  - NFS/SMB/iSCSI config     - separate identity     |   |
  |    |  - network interfaces      - access controls       |   |
  |    |  - namespace               - volumes               |   |
  |    |  - volume /db (100 GiB)    - volume /test (50 GiB)  |   |
  |    |  - volume /logs (20 GiB)                           |   |
  |    +----------------------------------------------------+   |
  |          underlying AWS-managed SSD capacity / tiering      |
  +-------------------------------------------------------------+

  Administrator --> AWS Console / AWS CLI / ONTAP management endpoint
  Client        --> SVM NFS/SMB/iSCSI endpoint (NOT management endpoint)
```

**Important:** The diagram is conceptual, not a physical block diagram. An SVM is **not** a VM with its own OS/kernel and is **not** the ONTAP server. ONTAP runs on AWS-managed storage nodes. The SVM is a logical storage server and security/namespace boundary implemented by ONTAP. Volumes are logical file systems owned by an SVM. One SVM can own many volumes; no separate SVM is needed for each volume.

### 2.2 Management plane vs data plane

| Plane | Endpoint | Protocol | Purpose | Typical account |
|---|---|---|---|---|
| File-system management | `management.<fs-id>.fsx.<region>.amazonaws.com` | SSH TCP/22, ONTAP management APIs | Cluster-wide administration within FSx limits | `fsxadmin` |
| SVM management | SVM management endpoint (if configured) | SSH TCP/22 | SVM-scoped administration | `vsadmin` |
| NFS data | SVM NFS endpoint | TCP/2049 | Linux/Unix file access | OS client |
| SMB data | SVM SMB endpoint / DNS name | TCP/445 | Windows file shares | AD user/service account |
| iSCSI data | SVM iSCSI endpoint | TCP/3260 | Block LUN access | iSCSI initiator |
| Intercluster | FSx intercluster endpoints | ONTAP replication traffic | SnapMirror/intercluster services | **Not** for administrator SSH |

### 2.3 Storage hierarchy, sizing, and billing

```text
FSx file system: 1024 GiB provisioned SSD capacity
  ├─ SVM svm1
  │    ├─ volume demovol1: 10 GiB logical size; junction /vol1
  │    ├─ volume postgres: 100 GiB logical size; junction /postgres
  │    └─ volume logs: 50 GiB logical size; junction /logs
  └─ SVM svm2
       └─ volume test: 100 GiB logical size
```

- The **1024 GiB** is file-system-level provisioned SSD capacity, **not 1024 GiB per SVM**.
- A **10 GiB volume does not consume the other 1014 GiB**; additional volumes can be created later.
- FSx ONTAP volumes are generally **thin provisioned**: logical provisioned size and physical consumed bytes differ.
- Available space is not necessarily `1024 − sum(volume sizes)`: snapshots, metadata, efficiency, SSD tiering, and reservations affect usage.
- **Billing:** Provisioned FSx SSD capacity is charged regardless of how much a small volume contains; other metered dimensions may apply.
- **FlexVol** is the usual volume style; **FlexGroup** is for much larger scale/parallelism requirements. Do not choose FlexGroup without workload review.
- A **junction path** (e.g., `/vol1`) exposes a volume within the SVM's NAS namespace; it is not the EC2 local mount path (e.g., `/mnt/fsx`).
- An **aggregate** is an ONTAP storage pool; in FSx its underlying resources are AWS-managed. L1/L1.5 should inspect, not reconfigure, aggregates.

### 2.4 NFS request flow

```text
Ubuntu EC2 --> DNS resolves SVM NFS endpoint --> TCP/2049
          --> SVM NFS service --> export-policy check
          --> junction /vol1 --> volume demovol1
          --> ONTAP storage layer --> AWS-managed SSD / tiered storage
```

### 2.5 iSCSI request flow (different from NFS)

```text
EC2 iSCSI initiator --> SVM iSCSI target IP:3260
  --> target / LUN mapping to initiator group (igroup)
  --> LUN inside volume --> block device on EC2
  --> client formats/mounts filesystem (or uses raw block)
```

> **Caution:** A LUN is not an NFS mount. Never format an existing LUN without explicit change approval and positive identification of the device.

---

## 3. Finding the right endpoint and security group

### 3.1 AWS Console navigation

1. **Amazon FSx → File systems → select FSx → Administration**: management DNS/IP, `fsxadmin` username.
2. **Amazon FSx → File systems → select FSx → Network & security**: VPC, subnet, networking details.
3. **Amazon FSx → Storage virtual machines → select SVM**: SVM management, NFS, SMB, iSCSI endpoints.
4. **Amazon FSx → Volumes**: volume sizes, associated SVM, junction paths.
5. **EC2 → Network Interfaces**: find the network interface IDs returned by `describe-file-systems`; inspect attached security groups. **Do not rely solely on filtering the endpoint IP**: it may not be an ENI's primary private IP.
6. **EC2 → Instances → select client → Security**: client security group and subnet.
7. **VPC → Route tables / Network ACLs**: routes and stateless filtering.

### 3.2 AWS CLI: discovery (run from authorized AWS CLI host)

```bash
export AWS_REGION=us-east-1
export FSX_ID=fs-xxxxxxxxxxxxxxxxx

aws sts get-caller-identity
aws fsx describe-file-systems --file-system-ids "$FSX_ID" --region "$AWS_REGION"
aws fsx describe-file-systems --file-system-ids "$FSX_ID" \
  --query 'FileSystems[0].{State:Lifecycle,VpcId:VpcId,ENIs:NetworkInterfaceIds,ONTAP:OntapConfiguration}' \
  --region "$AWS_REGION" --output json
aws fsx describe-storage-virtual-machines --region "$AWS_REGION"
aws fsx describe-volumes --region "$AWS_REGION"

# List the actual ENI IDs of the file system:
aws fsx describe-file-systems --file-system-ids "$FSX_ID" \
  --query 'FileSystems[0].NetworkInterfaceIds' --output text --region "$AWS_REGION"

# Replace with one of the returned ENI IDs:
aws ec2 describe-network-interfaces --network-interface-ids eni-EXAMPLE \
  --query 'NetworkInterfaces[*].{ENI:NetworkInterfaceId,VPC:VpcId,IP:PrivateIpAddress,Groups:Groups}' \
  --region "$AWS_REGION" --output json

aws ec2 describe-security-groups --group-ids sg-EXAMPLE --region "$AWS_REGION"
aws ec2 describe-instances --instance-ids i-EXAMPLE \
  --query 'Reservations[*].Instances[*].{VPC:VpcId,Subnet:SubnetId,PrivateIP:PrivateIpAddress,SGs:SecurityGroups}' \
  --region "$AWS_REGION" --output json
```

**Permissions:** AWS CLI calls require IAM rights; ONTAP `fsxadmin` does not automatically grant AWS IAM permissions.

---

## 4. ONTAP CLI access and command discovery

From a network-reachable EC2 host or VPN-connected workstation:

```bash
ssh -o ConnectTimeout=10 fsxadmin@<filesystem-management-dns>
# SVM-scoped administration, when SVM management endpoint is configured:
ssh vsadmin@<svm-management-dns>
```

After login, commands run at an ONTAP prompt such as `FsxId...::>`, **not** in a Linux shell.

```text
?                         # Show available top-level commands
volume ?                  # Show subcommands
volume show ?             # Show parameters
volume show -help         # Show syntax/help (if available)
set -privilege advanced   # DO NOT use casually: advanced commands need approval
```

> **Read-only default:** Stay at admin privilege. Do not enable advanced/diagnostic privilege for routine L1 tasks. Never assume a command from a generic ONTAP guide is permitted on AWS FSx.

---

## 5. ONTAP command reference — read-only first

### 5.1 Cluster, nodes, health, logs

| ONTAP command | What it answers | Typical interpretation / next step |
|---|---|---|
| `cluster show` | Is the cluster visible/healthy? | Note node membership/status; escalate unusual state. |
| `cluster identity show` | Which cluster am I in? | Confirm target before action. |
| `version` | ONTAP version | Check command compatibility. |
| `system node show` | What nodes are visible? | AWS may restrict node details. |
| `system health status show` | Overall health | Investigate degraded status. |
| `system health alert show` | Current alerts | Capture alert ID and time. |
| `event log show` | Recent EMS events | Filter around incident window. |
| `event log show -severity ERROR` | Error events | Severity spelling/options vary; use help. |
| `event log show -time >1h` | Recent events | Verify time-filter syntax in your release. |

### 5.2 SVM (vserver)

| ONTAP command | Use |
|---|---|
| `vserver show` | List SVMs and state. |
| `vserver show -instance` | Detailed SVM settings. |
| `vserver show -vserver <svm>` | Inspect one SVM. |
| `vserver show -fields state` | Operational state. |
| `vserver show -fields allowed-protocols` | Allowed protocols (may vary by version). |
| `vserver show -fields rootvolume` | SVM namespace root volume. |
| `network interface show -vserver <svm>` | SVM network LIFs. |
| `vserver nfs show -vserver <svm>` | NFS server config. |
| `vserver cifs show -vserver <svm>` | SMB/CIFS server config. |
| `vserver iscsi show -vserver <svm>` | iSCSI service config. |

**Interpretation:** SVM running does **not** guarantee NFS/SMB/iSCSI is configured or reachable. Verify the protocol service, endpoint, permissions, and client network separately.

### 5.3 Volumes, capacity, junctions, snapshots

| ONTAP command | Use |
|---|---|
| `volume show` | All visible volumes. |
| `volume show -vserver <svm>` | Volumes for one SVM. |
| `volume show -vserver <svm> -volume <vol> -instance` | Full volume details. |
| `volume show -fields size,available,used` | Size/usage fields where supported. |
| `volume show -fields state,junction-path,policy` | Online status, NAS junction, export policy. |
| `volume show-space -vserver <svm> -volume <vol>` | Detailed space consumption. |
| `df -h` | File-system/volume space view (availability may vary). |
| `df -A -h` | Aggregate space view, if permitted. |
| `storage aggregate show` | Aggregates visible to role. |
| `storage aggregate show-space` | Aggregate utilization, if permitted. |
| `volume snapshot show` | Snapshot inventory. |
| `volume snapshot show -vserver <svm> -volume <vol>` | Snapshots for one volume. |
| `volume snapshot policy show` | Snapshot schedules/policies. |
| `volume efficiency show` | Efficiency status, where supported. |

**Capacity rule:** Compare **volume logical capacity, actual volume used/available, snapshot usage, file-system SSD utilization, and tiering**. Do not infer physical free SSD from volume size alone.

### 5.4 ONTAP networking

| ONTAP command | Use |
|---|---|
| `network interface show` | List logical interfaces (LIFs). |
| `network interface show -vserver <svm>` | SVM LIFs. |
| `network interface show -fields address,status-admin,status-oper` | IPs and interface states (verify fields). |
| `network route show` | ONTAP routing view (restricted on some FSx). |
| `network port show` | Port details (restricted on some FSx). |
| `vserver services name-service dns show` | SVM DNS settings. |
| `network ping -vserver <svm> -destination <ip>` | Reachability test **if permitted**; ICMP can be blocked. |

**Critical:** ONTAP CLI cannot inspect AWS security groups, subnet NACLs, AWS route tables, or IAM policies. Use AWS tools for those.

### 5.5 NFS

| ONTAP command | Use |
|---|---|
| `vserver nfs show` | NFS services by SVM. |
| `vserver nfs show -vserver <svm> -instance` | NFS protocol configuration. |
| `vserver export-policy show` | Export policies. |
| `vserver export-policy rule show` | Export rules. |
| `vserver export-policy rule show -vserver <svm> -policyname <policy>` | Rules in one policy. |
| `volume show -vserver <svm> -fields junction-path,policy` | Junctions and attached export policy. |
| `vserver export-policy check-access ...` | Simulate access decision; see example below. |

Example of **access-policy simulation** (validate required arguments with `-help`):

```text
vserver export-policy check-access -vserver <svm> \
  -client-ip <ec2-private-ip> -volume <volume> \
  -authentication-method sys -protocol nfs3 -access-type read
```

**Important:** NFSv4.x identity mapping, export rules on the namespace path, and root-squash can also cause failures. Successful TCP/2049 connectivity does not prove authorization.

### 5.6 SMB / CIFS (Windows)

| ONTAP command | Use |
|---|---|
| `vserver cifs show` | SMB server state and identity. |
| `vserver cifs show -vserver <svm>` | SVM SMB server configuration. |
| `vserver cifs share show -vserver <svm>` | Published SMB shares. |
| `vserver cifs share access-control show -vserver <svm>` | Share permissions. |
| `vserver cifs session show -vserver <svm>` | Active SMB sessions (permissions permitting). |
| `vserver services name-service dns show -vserver <svm>` | DNS needed for AD. |
| `vserver cifs domain discovered-servers show -vserver <svm>` | AD server discovery, if available. |

**SMB permissions have layers:** share ACL **and** file/directory ACL, plus AD/DNS/Kerberos/time synchronization. L1 should not change AD join, shares or ACLs without approval.

### 5.7 iSCSI and LUNs

| ONTAP command | Use |
|---|---|
| `vserver iscsi show -vserver <svm>` | iSCSI service status. |
| `lun show -vserver <svm>` | LUN inventory. |
| `lun show -vserver <svm> -instance` | LUN properties. |
| `lun igroup show -vserver <svm>` | Initiator groups. |
| `lun mapping show -vserver <svm>` | Which LUN is mapped to which igroup. |
| `iscsi session show` | Active iSCSI sessions, if permitted. |

**Do not:** create/re-map LUNs, alter igroups, initialize disks, or run `mkfs` on a discovered device without explicit storage/change approval.

### 5.8 Replication, protection and QoS

| ONTAP command | Use |
|---|---|
| `snapmirror show` | Replication relationships/status. |
| `snapmirror show -instance` | Detailed replication state. |
| `volume snapshot show` | Snapshots. |
| `qos policy-group show` | QoS policy configuration. |
| `qos statistics volume performance show` | Volume performance if available. |
| `statistics catalog object show` | Available statistics objects. |
| `statistics catalog counter show` | Available counters. |

**Do not** initiate SnapMirror break/resync, snapshot restore, or QoS changes as routine L1/L1.5 work.

---

## 6. Linux client troubleshooting commands (Ubuntu/EC2)

```bash
# Identity and local network
hostname -f
ip -br addr
ip route
ip route get <fsx-management-ip>

# DNS (management or SVM DNS)
getent hosts <endpoint-dns>
resolvectl status                     # If systemd-resolved is used

# TCP tests (test the correct endpoint for the protocol)
nc -zv -w 5 <fsx-management-ip> 22     # ONTAP admin SSH
nc -zv -w 5 <svm-nfs-ip> 2049          # NFS
nc -zv -w 5 <svm-smb-ip> 445           # SMB
nc -zv -w 5 <svm-iscsi-ip> 3260        # iSCSI

# SSH diagnosis
ssh -vvv -o ConnectTimeout=10 fsxadmin@<management-dns>

# NFS client packages, mounts and errors
dpkg -l | grep nfs-common
findmnt -t nfs,nfs4
df -hT
nfsstat -m
mount | grep -E 'nfs|fsx'
sudo journalctl -k --since '30 minutes ago' | tail -100
sudo dmesg | tail -50

# Read-only NFS mount test, only if export is intended to be read-only:
sudo mkdir -p /mnt/fsx-test
sudo mount -t nfs -o ro,vers=4.1 <svm-nfs-dns>:/vol1 /mnt/fsx-test
findmnt /mnt/fsx-test
ls -la /mnt/fsx-test
sudo umount /mnt/fsx-test

# Check a local process's file use (useful when unmount reports busy):
sudo fuser -vm /mnt/fsx-test

# iSCSI client diagnosis (only where iSCSI is in use)
sudo systemctl status iscsid
sudo iscsiadm -m session
lsblk -f
sudo multipath -ll                    # If multipath-tools is configured
```

> **Client mount guidance:** A test mount is a change to the client namespace. Use an approved test host and non-production mountpoint. `showmount -e` can be misleading for NFSv4-only configurations; prefer TCP/2049 + approved mount test + ONTAP export policy review.

---

## 7. Windows SMB client troubleshooting (PowerShell)

```powershell
# DNS and network
Resolve-DnsName <svm-smb-dns>
Test-NetConnection <svm-smb-dns> -Port 445
ipconfig /all
route print

# SMB client view
Get-SmbConnection
Get-SmbMapping
net use

# Check whether the intended share can be listed (authorized account)
Get-ChildItem \\<svm-smb-dns>\<share-name>

# Time / domain troubleshooting (read-only)
w32tm /query /status
whoami /all
```

**Typical SMB errors:** name not found (DNS), TCP/445 timeout (network), logon failure (AD/auth), access denied (share or NTFS ACL), intermittent access (network, domain controllers, failover or client sessions).

---

## 8. AWS networking and platform diagnostics

### 8.1 Correct sequence for an SSH timeout

**Case study:** Ubuntu EC2 `172.31.43.59` resolves FSx management DNS to `172.31.95.5`, but `nc -zv -w 5 172.31.95.5 22` times out.

```text
DNS success ≠ TCP success ≠ SSH authentication success
```

1. Confirm the **management** endpoint, not `intercluster.*` or the SVM NFS endpoint.
2. Confirm FSx lifecycle is **AVAILABLE** and check AWS events.
3. Confirm EC2 and FSx **VPC IDs**; same `172.31.x.x` range does not prove same VPC.
4. Confirm client **outbound** TCP/22 and FSx ENI security group **inbound** TCP/22 from client security group or narrowly scoped CIDR.
5. Check both subnet route tables; same-VPC local route should be present. For cross-VPC, check peering/TGW/VPN routes and CIDR overlaps.
6. Check **network ACLs in both directions** (stateless): allow TCP/22 to destination and ephemeral return ports to client; also review local host firewall if present.
7. Re-test `nc`; only after TCP success troubleshoot SSH credentials and host keys.
8. If all configuration appears correct, collect VPC Flow Logs / Reachability Analyzer evidence and escalate to AWS/cloud network team.

**Never** open management SSH to `0.0.0.0/0` to diagnose a timeout.

### 8.2 AWS CLI checks

```bash
# File system state and configuration
aws fsx describe-file-systems --file-system-ids <fs-id> --region <region>

# SVM endpoints and state
aws fsx describe-storage-virtual-machines --region <region>

# Volume status
aws fsx describe-volumes --region <region>

# Network interface IDs (prefer this to searching by management IP)
aws fsx describe-file-systems --file-system-ids <fs-id> \
  --query 'FileSystems[0].NetworkInterfaceIds' --output text --region <region>

# ENI and SG association
aws ec2 describe-network-interfaces --network-interface-ids <eni-id> --region <region>

# Security group ingress/egress
aws ec2 describe-security-groups --group-ids <sg-id> --region <region>

# Route tables / NACLs for subnet(s)
aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<subnet-id> --region <region>
aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=<subnet-id> --region <region>

# EC2 subnet and security groups
aws ec2 describe-instances --instance-ids <instance-id> --region <region>
```

**Caveat:** A subnet may use the VPC main route table rather than an explicitly associated route table. If the subnet filter returns nothing, inspect the VPC's main route table. AWS FSx Single-AZ/Multi-AZ deployment types have different routing/endpoints; use the documented FSx networking model for the chosen deployment.

### 8.3 AWS monitoring

In **CloudWatch → Metrics → FSx**, review metrics relevant to your deployment, such as storage capacity/utilization, throughput, IOPS, client connections, and latency. **Exact metric names and availability vary by deployment generation and protocol.** Compare to the FSx throughput capacity, provisioned SSD IOPS, workload pattern and incident timestamp. Check CloudWatch alarms, AWS Health, FSx lifecycle state, backup status and maintenance events.

---

## 9. Incident runbooks (symptom → commands → diagnosis → action)

### R01 — Cannot SSH to ONTAP management endpoint

**Symptoms:** `ssh` hangs; `nc` timeout.

**Commands:**

```bash
getent hosts <management-dns>
nc -zv -w 5 <management-ip> 22
ssh -vvv -o ConnectTimeout=10 fsxadmin@<management-dns>
ip route get <management-ip>
```

**Interpretation:** DNS fails → resolver/VPC DNS. TCP timeout → SG/NACL/route/endpoint state. TCP connects but password denied → account/password/access policy. Host key changed → verify through approved security procedure; **do not blindly remove `known_hosts` entries**.

**L1 action:** Check FSx state, VPC/ENIs, inbound/outbound rules, routes, NACLs. **Escalate** if changes are needed without authorization.

### R02 — NFS mount hangs or times out

**Commands:**

```bash
getent hosts <svm-nfs-dns>
nc -zv -w 5 <svm-nfs-ip> 2049
findmnt -t nfs,nfs4
sudo journalctl -k --since '30 minutes ago' | tail -100
```

```text
vserver nfs show -vserver <svm>
network interface show -vserver <svm>
volume show -vserver <svm> -fields junction-path,policy,state
vserver export-policy rule show -vserver <svm>
```

**Check:** Wrong endpoint, NFS service disabled, port 2049 blocked, invalid junction, unsupported NFS version, export-policy mismatch, NFSv4 identity mapping.

### R03 — NFS `access denied by server`

**Commands:** `volume show -fields junction-path,policy`, `vserver export-policy rule show`, `vserver export-policy check-access ...`, client `id`, `nfsstat -m`.

**Check:** Client CIDR, allowed protocols, read/write/root rules, AUTH_SYS vs Kerberos, parent namespace access, root squash and UNIX UID/GID. **Do not** broadly open exports as a workaround.

### R04 — NFS mount succeeds but writes fail

**Commands:**

```bash
findmnt -no SOURCE,OPTIONS /mnt/<mount>
df -hT /mnt/<mount>
id
sudo journalctl -k --since '30 minutes ago' | tail -100
```

```text
volume show -vserver <svm> -volume <vol> -instance
volume show-space -vserver <svm> -volume <vol>
vserver export-policy rule show -vserver <svm>
```

**Check:** Read-only client mount, export `rorule`/`rwrule`, UNIX permissions, volume state, logical full, snapshot/space pressure, quota (if configured).

### R05 — Volume full / no space left

**Commands:** `volume show`, `volume show-space`, `volume snapshot show`, `df -h`, AWS FSx capacity metrics.

**Check:** Actual vs logical usage, snapshot reserve, deleted-but-open files on client, quotas, thin-provisioning overcommit, SSD capacity and tiering. **Do not delete snapshots or data without approval.** Escalate for volume resize/SSD capacity planning.

### R06 — FSx file system capacity alarm

**Commands:** AWS `describe-file-systems`, `describe-volumes`, CloudWatch SSD utilization and tiering metrics; ONTAP `storage aggregate show-space` if permitted.

**Check:** Provisioned SSD capacity, storage efficiency, active data, snapshots, tiering policies, rate of growth. **Escalate** before physical SSD exhaustion.

### R07 — Volume missing or offline

**Commands:**

```text
vserver show
volume show -vserver <svm>
volume show -vserver <svm> -volume <vol> -instance
volume show -fields state,junction-path
```

**Check:** Wrong SVM, renamed volume, offline state, missing junction, wrong namespace. **Do not online, rename, or move volumes without approved runbook.**

### R08 — SMB share unreachable

**Commands:** Windows `Resolve-DnsName`, `Test-NetConnection -Port 445`, `Get-SmbConnection`; ONTAP `vserver cifs show`, `vserver cifs share show`, `vserver cifs session show`.

**Check:** DNS/AD, TCP/445 SG/NACL, SMB service, share name, permissions, client credentials. **Escalate** AD and ACL changes.

### R09 — SMB `access denied` / authentication failures

**Commands:** `whoami /all`, `w32tm /query /status`, `Get-SmbConnection`, `vserver cifs share access-control show`, `vserver cifs domain discovered-servers show` (if available).

**Check:** AD identity, Kerberos/time skew, DNS/domain reachability, share permissions vs file ACLs. Do not reset service accounts or alter ACLs without approval.

### R10 — iSCSI LUN not visible

**Commands:**

```bash
sudo iscsiadm -m session
lsblk -f
sudo multipath -ll
nc -zv -w 5 <svm-iscsi-ip> 3260
```

```text
vserver iscsi show -vserver <svm>
lun show -vserver <svm>
lun igroup show -vserver <svm>
lun mapping show -vserver <svm>
```

**Check:** iSCSI endpoint/port, initiator IQN, target discovery/session, igroup membership, LUN mapping, multipath. **Do not format or re-map** as a troubleshooting shortcut.

### R11 — High latency / slow I/O

**Commands:** Client `iostat -xz 1 5` (if `sysstat` installed), `nfsstat -m`, ONTAP `qos statistics volume performance show` if available; AWS CloudWatch throughput, IOPS and latency.

**Check:** Client CPU/I/O wait, network retransmits, FSx throughput/IOPS limits, QoS throttling, workload I/O size and concurrency, capacity pressure, tiering recalls. Record baseline and time range. Escalate performance tuning/capacity changes.

### R12 — Intermittent connectivity / failover concerns

**Commands:** AWS FSx lifecycle/maintenance events, CloudWatch metrics, `system health alert show`, `event log show`, client kernel logs, connection tests over time.

**Check:** Scheduled maintenance, HA failover, client retry behavior, DNS caching, security/NACL/routing changes. Do not force takeover/giveback in FSx.

### R13 — Snapshot or replication issue

**Commands:** `volume snapshot show`, `volume snapshot policy show`, `snapmirror show`, `snapmirror show -instance`, AWS backup status.

**Check:** Snapshot schedule, replication lag, destination capacity, network/replication state. **Do not run restore, delete, break or resync commands without senior approval.**

### R14 — `command not found` or `not authorized` in ONTAP

**Commands:** `?`, `<command> ?`, `<command> -help`, `version`.

**Check:** Running in Ubuntu vs ONTAP prompt; wrong syntax/version; `vsadmin` vs `fsxadmin` scope; FSx-restricted command. Record exact error; do not elevate to advanced privilege as a workaround.

### R15 — `AccessDenied` from AWS CLI

**Commands:** `aws sts get-caller-identity`, `aws configure list`, repeat read-only API call with `--region`.

**Check:** IAM role/policy, session expiration, wrong account/region, SCP/permission boundary. ONTAP admin rights do not imply AWS IAM rights.

---

## 10. Quick decision tree for first response

```text
User reports storage issue
 |
 +-- FSx state AVAILABLE? -- No --> AWS FSx events/health; escalate platform
 |
 +-- Correct endpoint/protocol? -- No --> Fix target (management vs SVM)
 |
 +-- DNS resolves? -- No --> VPC DNS / resolver / AD DNS
 |
 +-- TCP port reachable? -- No --> SG -> NACL -> routes -> VPC -> endpoint
 |
 +-- Authentication succeeds? -- No --> ONTAP login / NFS export / SMB AD / iSCSI IQN
 |
 +-- Volume/LUN visible? -- No --> SVM, volume, junction, share, mapping
 |
 +-- Read/write succeeds? -- No --> ACL/export, volume state, quotas, space
 |
 +-- Slow/intermittent? --> Metrics, QoS, IOPS, throughput, client/network logs
 |
 +-- Evidence + approved remediation + verify + incident record
```

### Port cheat sheet

| Service | Typical TCP port | Target |
|---|---:|---|
| ONTAP admin SSH | 22 | File-system or SVM management endpoint |
| NFSv4.x | 2049 | SVM NFS endpoint |
| SMB | 445 | SVM SMB endpoint |
| iSCSI | 3260 | SVM iSCSI endpoint |
| DNS | 53 UDP/TCP | Configured DNS resolver |
| Kerberos | 88 TCP/UDP | AD/KDC, when used |
| LDAP / LDAPS | 389 / 636 | Directory services, when used |

**NFSv3** may require additional RPC/mount services and ports depending on configuration; do not assume TCP/2049 is the only requirement for NFSv3. AWS/NetApp guidance for the specific NFS version takes precedence.

---

## 11. Approved vs high-risk commands

### Typically safe read-only

```text
cluster show
version
system health status show
system health alert show
event log show
vserver show
volume show
volume show-space
volume snapshot show
storage aggregate show
network interface show
network route show
vserver nfs show
vserver export-policy rule show
vserver cifs show
vserver cifs share show
vserver iscsi show
lun show
lun mapping show
snapmirror show
```

### High-risk: senior storage engineer / formal change required

| Action | Why risky |
|---|---|
| `volume delete`, `volume offline`, `volume unmount` | Data loss or access outage |
| `volume snapshot delete`, snapshot restore | Removes recovery points or overwrites newer data |
| `volume modify` (size, policy, security style) | Capacity/permissions impact |
| `vserver export-policy rule create/modify/delete` | Can grant or remove client access |
| SMB share/ACL modifications | Security and availability impact |
| `lun mapping create/delete`, igroup changes | Wrong host can access LUN; outage/data corruption |
| `snapmirror break/resync/delete` | Replication/recovery impact |
| Aggregate/HA/network LIF changes | Platform-level impact; often FSx-restricted |
| Client `mkfs`, `wipefs`, `dd`, partition changes | Irreversible data destruction |

---

## 12. Incident evidence collection template

```text
Incident ID:
Reported by / affected service:
Severity / start time (UTC):
AWS account / region:
FSx file system ID / deployment type / lifecycle:
SVM / volume / junction or share / LUN:
Client instance ID, OS, private IP, VPC, subnet:
Protocol / destination endpoint / port:
Observed error (exact text):
DNS test + result:
TCP test + result:
Security group / route / NACL findings:
ONTAP read-only output:
AWS CloudWatch / FSx health observations:
Last known good time / recent changes:
Blast radius (one client, one volume, one SVM, entire FSx):
Actions performed (with change ID):
Post-change verification:
Escalation owner and next update:
```

**Security:** Remove passwords, access tokens, private keys, user PII, and sensitive hostnames from shared incident artifacts. Do not paste admin passwords into tickets.

---

## 13. Training labs and assessment

### Lab A — Identify the architecture (20 min)

Given a 1024 GiB FSx file system with one SVM and two volumes, identify the ONTAP management endpoint, SVM data endpoint, volume junctions, and explain thin provisioning.

**Pass:** Engineer distinguishes management IP from NFS IP and knows one SVM can own many volumes.

### Lab B — SSH timeout (30 min)

EC2 resolves management DNS but `nc <management-ip> 22` times out. Trace FSx ENIs, security groups, VPC, subnet routes, NACLs, client outbound policy. Do not change rules without instructor approval.

**Pass:** Engineer correctly isolates network vs authentication fault and proposes least-privilege rule.

### Lab C — NFS mount denied (30 min)

NFS TCP/2049 works, mount returns access denied. Inspect junction path, NFS service, export-policy association and rule, client CIDR and protocol.

**Pass:** Engineer identifies access-policy fault without making broad allow-all changes.

### Lab D — Volume nearly full (25 min)

Review `volume show-space`, snapshot inventory and FSx CloudWatch capacity metrics. Distinguish volume logical full from file-system SSD pressure.

**Pass:** Engineer recommends correct escalation and avoids unapproved snapshot deletion.

### Lab E — SMB and iSCSI triage (30 min)

SMB: differentiate TCP/445 failure from AD/ACL failure. iSCSI: differentiate TCP/3260 failure from igroup/LUN mapping failure.

**Pass:** Engineer selects the correct diagnostic commands and avoids destructive client operations.

### Lab F — Mock incident handoff (15 min)

Produce a completed evidence template, incident timeline, fault-domain hypothesis, approved next step, and escalation.

**Pass:** Another engineer can continue troubleshooting without repeating discovery.

---

## 14. Instructor quick-reference: fault domain matrix

| Symptom | First command | Second check | Likely owner |
|---|---|---|---|
| SSH hangs | `nc -zv -w 5 <mgmt-ip> 22` | FSx ENI SG/NACL/routes | Cloud network |
| SSH password rejected | `ssh -vvv fsxadmin@<mgmt>` | Account/password/access | Storage admin |
| NFS mount timeout | `nc -zv -w 5 <nfs-ip> 2049` | NFS SVM service, SG | Network/storage |
| NFS access denied | `vserver export-policy rule show` | `check-access`, client UID | Storage/Linux |
| NFS read-only | `findmnt -no OPTIONS <mount>` | Export RW rules, volume state | Linux/storage |
| SMB share unreachable | `Test-NetConnection <smb> -Port 445` | DNS/SG/SMB service | Network/storage |
| SMB access denied | `whoami /all` | Share and file ACLs | AD/storage |
| iSCSI LUN missing | `iscsiadm -m session` | `lun mapping show` | Storage/Linux |
| Volume full | `volume show-space` | Snapshots / FSx SSD metrics | Storage/cloud |
| Slow I/O | CloudWatch metrics | `iostat`, QoS | Performance/storage |
| Replication lag | `snapmirror show` | destination capacity/events | Senior storage |
| FSx degraded | AWS FSx status | AWS Health / ONTAP alerts | AWS/platform |

---

## 15. Frequently confused concepts (trainer talking points)

**Q: Is SVM the ONTAP server?**  
A: No. ONTAP runs on AWS-managed nodes; SVM is a logical storage server defined within ONTAP.

**Q: Is an SVM a client?**  
A: No. EC2 is the client; the SVM exposes data services to clients.

**Q: Must I create an SVM for every volume?**  
A: No. An SVM can contain many volumes.

**Q: Does `fsxadmin` SSH remove the need for an SVM?**  
A: No. ONTAP CLI manages the system; a data SVM is needed for client-facing file/block services.

**Q: If I create a 10 GiB volume on 1024 GiB FSx, is 1014 GiB lost?**  
A: No. Volume size is logical; remaining physical capacity is shared and can support more volumes, subject to usage and overhead.

**Q: Can I SSH to an intercluster endpoint?**  
A: Do not use it for administration; use the management endpoint.

**Q: Can I SSH directly from my laptop?**  
A: Only with network reachability to the private management endpoint (e.g., VPN/Direct Connect or secure jump host). It is not normally publicly reachable.

**Q: Does an AWS security group attach to each volume?**  
A: No. AWS security groups attach to the file system's network interfaces; ONTAP export/share/LUN policies provide additional access controls.

**Q: Is FSx ONTAP identical to on-prem ONTAP?**  
A: The ONTAP concepts and many commands are similar, but AWS controls the underlying infrastructure and restricts some administrative actions.

---

## 16. Reference documentation (verify release-specific syntax)

- AWS FSx for ONTAP overview: https://docs.aws.amazon.com/fsx/latest/ONTAPGuide/what-is-fsx-ontap.html
- AWS FSx for ONTAP user guide: https://docs.aws.amazon.com/fsx/latest/ONTAPGuide/
- AWS CLI FSx reference: https://docs.aws.amazon.com/cli/latest/reference/fsx/
- AWS CLI EC2 networking reference: https://docs.aws.amazon.com/cli/latest/reference/ec2/
- NetApp ONTAP command reference: https://docs.netapp.com/us-en/ontap-cli/
- NetApp ONTAP system administration: https://docs.netapp.com/us-en/ontap/system-admin/
- AWS VPC security groups: https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html
- AWS VPC network ACLs: https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html
- AWS VPC Reachability Analyzer: https://docs.aws.amazon.com/vpc/latest/reachability/what-is-reachability-analyzer.html

> **Trainer note:** Before live delivery, test every demonstration command against the **actual FSx ONTAP version, deployment type and role** in the lab. Commands in this handbook are broad operational examples; some are deliberately marked conditional or restricted. Use the read-only troubleshooting commands as the baseline for L1 and L1.5 engineers.
