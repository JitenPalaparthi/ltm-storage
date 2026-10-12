# run the commands on an instance like ec2 (Ubuntu/Debian destro only)

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


