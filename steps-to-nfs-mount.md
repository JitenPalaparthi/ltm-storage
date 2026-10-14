# run the commands on an instance like ec2 (Ubuntu/Debian destro only)

```bash
sudo apt update

sudo apt install nfs-common -y

sudo mkdir -p /mnt/ontap

sudo mount -t nfs \
  -o vers=4.1 \
  172.31.255.205:/vol1 \
  /mnt/ontap

  df -hT

  findmnt /mnt/ontap

  echo "Hello ONTAP" | sudo tee /mnt/ontap/test.txt

  cat /mnt/ontap/test.txt
```

  # LVM 

```bash
sudo apt update
sudo apt install lvm2 -y

# the volume has been attached to the dev 
ldblk 

#create a physical volume
sudo pvcreate /dev/xvde

#create a volume group
sudo vgcreate vg_data /dev/xvde

sudo vgs

# create a logical volume

sudo lvcreate -L 5G -n lv_data vg_data

#create a file system

sudo mkfs.ext4 /dev/vg_data/lv_data

# create a mount directory
sudo mkdir -p /mnt/data

# mount the logical volume to the directory

sudo mount /dev/vg_data/lv_data /mnt/data

# create another volume

sudo lvcreate -L 5G -n lv_backup vg_data

follow all steps to create fs and also mount

```

# storage is full on elb volume

```baah
sudo pvresize /dev/xvde

sudo pvs

sudo vgs

sudo lvextend -l +100%FREE /dev/vg_data/lv_data

df -hT /mnt/data # you dont find it is expanded

# expand etx4 file system to the newly allocated storage
sudo resize2fs /dev/vg_data/lv_data

df -hT /mnt/data

```

# benchmarking tools 

```bash
# install tools
sudo apt update
sudo apt install fio sysstat -y
# generate a testfils
sudo dd if=/dev/zero of=/mnt/data/testfile.bin \
  bs=1M count=1024 oflag=direct status=progress


